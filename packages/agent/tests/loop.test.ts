// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { runTurn, type StreamChunk, type LoopOptions } from "../src/core/loop.ts";
import { collect } from "../src/core/events.ts";
import { ToolRegistry, type Tool } from "../src/core/tools/registry.ts";
import { ApprovalStore } from "../src/core/approvals.ts";
import type { AgentMessage } from "../src/core/messages.ts";

/** A transport that replays scripted responses, one per model round-trip. */
function scripted(rounds: StreamChunk[][]) {
  let i = 0;
  return async function* () {
    const round = rounds[i++] ?? [];
    for (const chunk of round) yield chunk;
  };
}

function registryWith(tool: Tool): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool);
  return r;
}

const echoAuto: Tool = {
  name: "read_file",
  tier: "auto",
  description: { "en-US": "read", "zh-CN": "读" },
  parameters: { type: "object", properties: { path: { type: "string" } } },
  run: async (args) => `contents of ${String(args.path)}`,
};

function opts(over: Partial<LoopOptions> & Pick<LoopOptions, "transport">): LoopOptions {
  const { sink } = collect();
  return {
    tools: registryWith(echoAuto),
    approvals: new ApprovalStore([]),
    ask: async () => "deny",
    sink,
    model: "qwen-max",
    language: "en-US",
    ...over,
  };
}

test("a text-only turn emits deltas and one assistant message", async () => {
  const { sink, events } = collect();
  const messages: AgentMessage[] = [{ role: "user", content: "hi" }];

  const out = await runTurn(
    messages,
    opts({ transport: scripted([[{ text: "Hel" }, { text: "lo" }]]), sink }),
  );

  expect(events.filter((e) => e.type === "text_delta").length).toBe(2);
  expect(out.filter((m) => m.role === "assistant")).toHaveLength(1);
  expect(out.at(-1)).toMatchObject({ role: "assistant", content: "Hello" });
});

test("a turn with text AND tool calls still produces exactly one assistant message", async () => {
  const messages: AgentMessage[] = [{ role: "user", content: "read a.ts" }];

  const out = await runTurn(
    messages,
    opts({
      transport: scripted([
        [
          { text: "Checking." },
          {
            toolCall: { index: 0, id: "c1", name: "read_file", argumentsDelta: '{"path":"a.ts"}' },
          },
        ],
        [{ text: "Done." }],
      ]),
    }),
  );

  const assistants = out.filter((m) => m.role === "assistant");
  expect(assistants).toHaveLength(2); // one per round-trip, not two for the first
  expect(assistants[0]).toMatchObject({ content: "Checking." });
});

test("auto-tier tools run without asking", async () => {
  let asked = 0;
  const out = await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      transport: scripted([
        [
          {
            toolCall: { index: 0, id: "c1", name: "read_file", argumentsDelta: '{"path":"a.ts"}' },
          },
        ],
        [{ text: "ok" }],
      ]),
      ask: async () => {
        asked++;
        return "allow";
      },
    }),
  );

  expect(asked).toBe(0);
  expect(out.some((m) => m.role === "tool" && m.content.includes("contents of a.ts"))).toBe(true);
});

test("ask-tier tools are denied when the user declines, and the model is told", async () => {
  const askTool: Tool = { ...echoAuto, name: "write_file", tier: "ask" };
  const out = await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(askTool),
      transport: scripted([
        [{ toolCall: { index: 0, id: "c1", name: "write_file", argumentsDelta: "{}" } }],
        [{ text: "understood" }],
      ]),
      ask: async () => "deny",
    }),
  );

  const toolMsg = out.find((m) => m.role === "tool");
  expect(toolMsg?.content).toMatch(/denied/i);
});

test("allow_always records a rule so the next identical call does not ask", async () => {
  const askTool: Tool = { ...echoAuto, name: "shell", tier: "ask" };
  const approvals = new ApprovalStore([]);
  let asked = 0;

  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(askTool),
      approvals,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "shell",
              argumentsDelta: '{"command":"pnpm test"}',
            },
          },
        ],
        [{ text: "ok" }],
      ]),
      ask: async () => {
        asked++;
        return "allow_always";
      },
    }),
  );

  expect(asked).toBe(1);
  expect(approvals.isAllowed("shell", { command: "pnpm test --run" })).toBe(true);
});

test("never-tier tools are refused without asking", async () => {
  const neverTool: Tool = { ...echoAuto, name: "destroy", tier: "never" };
  let asked = 0;
  const out = await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(neverTool),
      transport: scripted([
        [{ toolCall: { index: 0, id: "c1", name: "destroy", argumentsDelta: "{}" } }],
        [{ text: "ok" }],
      ]),
      ask: async () => {
        asked++;
        return "allow";
      },
    }),
  );

  expect(asked).toBe(0);
  expect(out.find((m) => m.role === "tool")?.content).toMatch(/not permitted/i);
});

test("the tool loop is capped so it cannot spend without bound", async () => {
  const endless = async function* (): AsyncIterable<StreamChunk> {
    yield { toolCall: { index: 0, id: "c", name: "read_file", argumentsDelta: '{"path":"a"}' } };
  };
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: "go" }],
    opts({ transport: endless, sink, maxIterations: 3 }),
  );

  const errors = events.filter((e) => e.type === "error");
  expect(errors.length).toBe(1);
  expect(events.filter((e) => e.type === "tool_call").length).toBe(3);
});

test("a transport failure surfaces as an error event, not an exception", async () => {
  const failing = async function* (): AsyncIterable<StreamChunk> {
    throw new Error("network down");
    yield { text: "unreachable" };
  };
  const { sink, events } = collect();

  await runTurn([{ role: "user", content: "hi" }], opts({ transport: failing, sink }));

  expect(events.find((e) => e.type === "error")).toMatchObject({ message: /network down/ });
});
