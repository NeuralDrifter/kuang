// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * What belongs on screen, decided without a screen.
 *
 * The split that matters is between lines that can never change again and the
 * reply still arriving: the first are printed once and forgotten, the second
 * redraws on every chunk. Getting that wrong is what makes a long conversation
 * crawl, so it is tested here rather than discovered on a slow terminal.
 */
import { expect, test } from "vite-plus/test";
import type { AgentEvent } from "../src/core/events.ts";
import {
  emptyTranscript,
  reduce,
  withNotice,
  withUserMessage,
  type TranscriptState,
} from "../src/ui/ink/transcript.ts";

function fold(events: AgentEvent[], from: TranscriptState = emptyTranscript()): TranscriptState {
  return events.reduce(reduce, from);
}

const usage = { promptTokens: 10, completionTokens: 5 };

test("a streaming reply is not finished until the turn ends", () => {
  const mid = fold([{ type: "turn_start" }, { type: "text_delta", text: "hel" }]);

  // Still moving, so it must stay in the part that redraws.
  expect(mid.streaming).toBe("hel");
  expect(mid.done).toHaveLength(0);
});

test("chunks accumulate in order", () => {
  const state = fold([
    { type: "text_delta", text: "one " },
    { type: "text_delta", text: "two" },
  ]);
  expect(state.streaming).toBe("one two");
});

test("the turn ending moves the reply into the part that never redraws", () => {
  const state = fold([
    { type: "turn_start" },
    { type: "text_delta", text: "all done" },
    { type: "turn_end", usage },
  ]);

  expect(state.streaming).toBe("");
  expect(state.done.map((e) => [e.kind, e.text])).toEqual([["reply", "all done"]]);
});

test("a turn that produced no text adds no empty line", () => {
  const state = fold([{ type: "turn_start" }, { type: "turn_end", usage }]);
  expect(state.done).toHaveLength(0);
});

test("tokens accumulate across turns rather than being replaced", () => {
  const state = fold([
    { type: "turn_end", usage },
    { type: "turn_end", usage: { promptTokens: 1, completionTokens: 2 } },
  ]);
  expect(state.tokens).toEqual({ prompt: 11, completion: 7 });
});

test("busy is set while a turn runs and cleared when it ends", () => {
  expect(fold([{ type: "turn_start" }]).busy).toBe(true);
  expect(fold([{ type: "turn_start" }, { type: "turn_end", usage }]).busy).toBe(false);
});

test("an error clears busy, so the UI cannot be left spinning", () => {
  const state = fold([{ type: "turn_start" }, { type: "error", message: "network down" }]);
  expect(state.busy).toBe(false);
  expect(state.done.at(-1)).toMatchObject({ kind: "error", text: "network down" });
});

test("a failed tool result is marked as failed, not just printed", () => {
  const state = fold([
    { type: "tool_result", callId: "c1", ok: false, summary: "Denied by the user" },
  ]);
  expect(state.done.at(-1)).toMatchObject({ kind: "tool", ok: false });
});

test("a redaction notice names rules and counts, never values", () => {
  const state = fold([{ type: "redacted", counts: { EMAIL: 2, CARD: 1 } }]);

  const text = state.done.at(-1)!.text;
  expect(text).toContain("1 CARD");
  expect(text).toContain("2 EMAIL");
  // Sorted, so the same turn always reads the same way.
  expect(text.indexOf("CARD")).toBeLessThan(text.indexOf("EMAIL"));
});

test("an approval preview keeps its diff on its own lines", () => {
  const state = fold([
    {
      type: "tool_approval_required",
      call: { id: "c1", name: "write_file", arguments: "{}" },
      preview: { summary: "write_file(a.ts)", diff: "--- a.ts\n+++ a.ts\n+x" },
    },
  ]);
  expect(state.done.at(-1)!.text).toBe("write_file(a.ts)\n--- a.ts\n+++ a.ts\n+x");
});

test("entries carry distinct ids, so a list can key off them", () => {
  const state = fold([
    { type: "tool_result", callId: "c1", ok: true, summary: "a" },
    { type: "tool_result", callId: "c2", ok: true, summary: "b" },
  ]);
  const ids = state.done.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a user message and a notice both land in the finished part", () => {
  let state = withUserMessage(emptyTranscript(), "hello");
  state = withNotice(state, "Redaction: on");

  expect(state.done.map((e) => e.kind)).toEqual(["user", "notice"]);
  // Submitting marks the UI busy before any event has arrived.
  expect(state.busy).toBe(true);
});

test("folding never mutates the state it was given", () => {
  const before = emptyTranscript();
  const after = reduce(before, { type: "text_delta", text: "x" });

  // React decides what to redraw by identity; mutating in place would show
  // nothing changing while everything did.
  expect(before.streaming).toBe("");
  expect(after).not.toBe(before);
});
