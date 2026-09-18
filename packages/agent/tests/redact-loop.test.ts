// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The redaction boundary, exercised through the real turn loop.
 *
 * One sanitize point inbound and one restore point outbound, so a value only
 * has to be caught once regardless of which tool produced it.
 */
import { expect, test } from "vite-plus/test";
import { ApprovalStore } from "../src/core/approvals.ts";
import { collect } from "../src/core/events.ts";
import { runTurn, type LoopOptions, type StreamChunk } from "../src/core/loop.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBaselines } from "../src/core/file-baselines.ts";
import type { AgentMessage } from "../src/core/messages.ts";
import { Vault } from "../src/core/redact/vault.ts";
import { ToolRegistry, type Tool } from "../src/core/tools/registry.ts";

const CARD = "4111 1111 1111 1111";

function scripted(rounds: StreamChunk[][]) {
  let round = 0;
  return async function* () {
    const chunks = rounds[round] ?? [];
    round += 1;
    for (const chunk of chunks) yield chunk;
  };
}

/** A tool that reports back whatever argument it was handed. */
function echoTool(seen: string[]): Tool {
  return {
    name: "read_file",
    tier: "auto",
    description: { "en-US": "read", "zh-CN": "读" },
    parameters: { type: "object", properties: { path: { type: "string" } } },
    run: async (args) => {
      seen.push(String(args.path));
      return `contents: ${CARD}`;
    },
  };
}

function registryWith(tool: Tool): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool);
  return r;
}

function opts(over: Partial<LoopOptions> & Pick<LoopOptions, "transport">): LoopOptions {
  const { sink } = collect();
  return {
    tools: registryWith(echoTool([])),
    approvals: new ApprovalStore(),
    ask: async () => "allow",
    sink,
    model: "qwen-max",
    language: "en-US",
    baselines: new FileBaselines(mkdtempSync(join(tmpdir(), "kuang-redact-"))),
    ...over,
  };
}

/** Capture the request body the transport was handed. */
function capturing(rounds: StreamChunk[][]) {
  const bodies: unknown[] = [];
  const inner = scripted(rounds);
  return {
    bodies,
    transport: (body: unknown) => {
      bodies.push(body);
      return inner();
    },
  };
}

test("a secret the user typed never reaches the request body", async () => {
  const vault = new Vault();
  const cap = capturing([[{ text: "noted" }]]);

  await runTurn(
    [{ role: "user", content: `my card is ${CARD}` }],
    opts({ transport: cap.transport, vault }),
  );

  const wire = JSON.stringify(cap.bodies[0]);
  expect(wire).not.toContain("4111");
  expect(wire).toContain("REDACTED_CARD_1");
});

test("a secret inside a tool result never reaches the request body", async () => {
  const vault = new Vault();
  const cap = capturing([
    [{ toolCall: { index: 0, id: "c1", name: "read_file", argumentsDelta: '{"path":"a.env"}' } }],
    [{ text: "done" }],
  ]);

  await runTurn([{ role: "user", content: "read it" }], opts({ transport: cap.transport, vault }));

  // The tool returned the card; the second round-trip must not carry it.
  const second = JSON.stringify(cap.bodies[1]);
  expect(second).not.toContain("4111");
  expect(second).toContain("REDACTED_CARD_1");
});

test("the transcript itself keeps the real values", async () => {
  const vault = new Vault();
  const cap = capturing([[{ text: "ok" }]]);

  const out = await runTurn(
    [{ role: "user", content: `card ${CARD}` }],
    opts({ transport: cap.transport, vault }),
  );

  // Only the wire copy is redacted — nothing downstream should have to restore.
  expect(JSON.stringify(out)).toContain("4111");
});

test("a placeholder in a tool argument is restored before the tool runs", async () => {
  const vault = new Vault();
  // Teach the vault the value, so the model can legitimately echo its placeholder.
  const id = vault.sanitize(CARD).text;

  const seen: string[] = [];
  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(echoTool(seen)),
      vault,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "read_file",
              argumentsDelta: JSON.stringify({ path: id }),
            },
          },
        ],
        [{ text: "done" }],
      ]),
    }),
  );

  // Writing `[REDACTED_CARD_1]` into a real file would be the worst outcome.
  expect(seen).toEqual([CARD]);
});

test("text shown to the user has placeholders restored", async () => {
  const vault = new Vault();
  const id = vault.sanitize(CARD).text;
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: "go" }],
    opts({ vault, sink, transport: scripted([[{ text: `your card is ${id}` }]]) }),
  );

  const shown = events
    .filter((e): e is Extract<typeof e, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

  expect(shown).toBe(`your card is ${CARD}`);
});

test("a placeholder split across stream chunks is still restored for display", async () => {
  const vault = new Vault();
  const id = vault.sanitize(CARD).text;
  const { sink, events } = collect();

  const half = Math.floor(id.length / 2);
  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      vault,
      sink,
      transport: scripted([[{ text: `card ${id.slice(0, half)}` }, { text: id.slice(half) }]]),
    }),
  );

  const shown = events
    .filter((e): e is Extract<typeof e, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

  expect(shown).toBe(`card ${CARD}`);
  expect(shown).not.toContain("REDACTED");
});

test("without a vault the loop behaves exactly as before", async () => {
  const cap = capturing([[{ text: "ok" }]]);
  const messages: AgentMessage[] = [{ role: "user", content: `card ${CARD}` }];

  await runTurn(messages, opts({ transport: cap.transport }));

  // Redaction is opt-in; no vault means no interference.
  expect(JSON.stringify(cap.bodies[0])).toContain("4111");
});

test("a disabled vault passes content through untouched", async () => {
  const vault = new Vault(false);
  const cap = capturing([[{ text: "ok" }]]);

  await runTurn(
    [{ role: "user", content: `card ${CARD}` }],
    opts({ transport: cap.transport, vault }),
  );

  expect(JSON.stringify(cap.bodies[0])).toContain("4111");
});

// ── telling the user it happened ────────────────────────────────────────────

test("the loop reports what it withheld, naming rules and not values", async () => {
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: `card ${CARD} mail mike@realdomain.co.uk` }],
    opts({ vault: new Vault(), sink, transport: scripted([[{ text: "ok" }]]) }),
  );

  const notices = events.filter((e) => e.type === "redacted");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toEqual({ type: "redacted", counts: { CARD: 1, EMAIL: 1 } });
  // The notice is printed to the same terminal the secret came from, but it
  // must not be another place the value is written down.
  expect(JSON.stringify(notices[0])).not.toContain("4111");
});

test("a secret is announced once, not on every round-trip", async () => {
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: "read it" }],
    opts({
      vault: new Vault(),
      sink,
      // Two round-trips, and the whole transcript is re-sent on the second.
      transport: scripted([
        [{ toolCall: { index: 0, id: "c1", name: "read_file", argumentsDelta: '{"path":"a"}' } }],
        [{ text: "done" }],
      ]),
    }),
  );

  // The tool result carries the card, so it is captured on round two only.
  const notices = events.filter((e) => e.type === "redacted");
  expect(notices).toHaveLength(1);
});

test("nothing is announced when nothing was sensitive", async () => {
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: "what is 2 + 2" }],
    opts({
      tools: registryWith({ ...echoTool([]), run: async () => "4" }),
      vault: new Vault(),
      sink,
      transport: scripted([[{ text: "4" }]]),
    }),
  );

  expect(events.filter((e) => e.type === "redacted")).toHaveLength(0);
});

test("a disabled vault announces nothing", async () => {
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: `card ${CARD}` }],
    opts({ vault: new Vault(false), sink, transport: scripted([[{ text: "ok" }]]) }),
  );

  expect(events.filter((e) => e.type === "redacted")).toHaveLength(0);
});

test("the tool call shown to the user has its arguments restored", async () => {
  const vault = new Vault();
  const id = vault.sanitize(CARD).text;
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      vault,
      sink,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "read_file",
              argumentsDelta: JSON.stringify({ path: id }),
            },
          },
        ],
        [{ text: "done" }],
      ]),
    }),
  );

  // The approval diff under this line shows real values; a raw placeholder
  // here would make one call look like two different things.
  const shown = events.find((e) => e.type === "tool_call");
  expect(shown && "call" in shown ? shown.call.arguments : "").toContain(CARD);
});

// ── placeholders the vault cannot resolve ───────────────────────────────────

test("a tool is refused when an argument holds a placeholder that was never issued", async () => {
  const vault = new Vault();
  vault.sanitize(CARD); // issues _1, so _99 below is plainly invented

  const seen: string[] = [];
  const out = await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(echoTool(seen)),
      vault,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "read_file",
              argumentsDelta: JSON.stringify({ path: "[REDACTED_CARD_99]" }),
            },
          },
        ],
        [{ text: "understood" }],
      ]),
    }),
  );

  // Running it would write the placeholder text itself into a real file.
  expect(seen).toEqual([]);
  const toolReply = out.find((m) => m.role === "tool");
  expect(JSON.stringify(toolReply)).toContain("REDACTED_CARD_99");
  expect(JSON.stringify(toolReply)).toContain("never issued");
});

test("the refusal names the placeholder so the model can correct itself", async () => {
  const vault = new Vault();
  const { sink, events } = collect();

  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      vault,
      sink,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "read_file",
              argumentsDelta: JSON.stringify({ path: "[REDACTED_EMAIL_3]" }),
            },
          },
        ],
        [{ text: "ok" }],
      ]),
    }),
  );

  const failure = events.find((e) => e.type === "tool_result" && !e.ok);
  expect(failure && "summary" in failure ? failure.summary : "").toContain("REDACTED_EMAIL_3");
});

test("a legitimate placeholder still resolves and runs", async () => {
  const vault = new Vault();
  const id = vault.sanitize(CARD).text;

  const seen: string[] = [];
  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(echoTool(seen)),
      vault,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "read_file",
              argumentsDelta: JSON.stringify({ path: id }),
            },
          },
        ],
        [{ text: "done" }],
      ]),
    }),
  );

  // The guard must not break the feature it protects.
  expect(seen).toEqual([CARD]);
});

test("text that merely resembles a placeholder is not treated as one", async () => {
  const vault = new Vault();
  const seen: string[] = [];

  await runTurn(
    [{ role: "user", content: "go" }],
    opts({
      tools: registryWith(echoTool(seen)),
      vault,
      transport: scripted([
        [
          {
            toolCall: {
              index: 0,
              id: "c1",
              name: "read_file",
              argumentsDelta: JSON.stringify({ path: "docs/[REDACTED].md" }),
            },
          },
        ],
        [{ text: "done" }],
      ]),
    }),
  );

  // Only the issued syntax counts; a real filename must not be blocked.
  expect(seen).toEqual(["docs/[REDACTED].md"]);
});
