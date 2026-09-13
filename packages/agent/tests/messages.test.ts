// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { assistantMessage, toWireMessages } from "../src/core/messages.ts";

test("a turn with text and tool calls is ONE assistant message", () => {
  const msg = assistantMessage("I'll check that file.", [
    { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
  ]);
  expect(msg.role).toBe("assistant");
  expect(msg.content).toBe("I'll check that file.");
  expect(msg.toolCalls).toHaveLength(1);
});

test("a turn with only text has no tool calls", () => {
  const msg = assistantMessage("Done.", []);
  expect(msg.toolCalls).toHaveLength(0);
});

test("tool calls serialise to the OpenAI wire shape", () => {
  const wire = toWireMessages([
    assistantMessage("checking", [{ id: "c1", name: "read_file", arguments: "{}" }]),
    { role: "tool", toolCallId: "c1", content: "file contents" },
  ]) as Array<Record<string, unknown>>;

  expect(wire[0]).toEqual({
    role: "assistant",
    content: "checking",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  expect(wire[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "file contents" });
});

test("an assistant message with no tool calls omits tool_calls on the wire", () => {
  const wire = toWireMessages([assistantMessage("hi", [])]) as Array<Record<string, unknown>>;
  expect(wire[0]).toEqual({ role: "assistant", content: "hi" });
  expect("tool_calls" in wire[0]).toBe(false);
});
