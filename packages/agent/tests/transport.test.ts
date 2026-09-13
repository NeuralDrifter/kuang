// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { chunksFromSSE } from "../src/core/transport.ts";

/** Replay raw SSE `data:` payloads as the parser would hand them over. */
async function* sse(payloads: string[]) {
  for (const data of payloads) yield { data } as { data: string };
}

test("text deltas become text chunks", async () => {
  const out = [];
  for await (const c of chunksFromSSE(
    sse([JSON.stringify({ choices: [{ delta: { content: "hi" } }] })]),
  )) {
    out.push(c);
  }
  expect(out).toEqual([{ text: "hi" }]);
});

test("tool-call deltas carry their index for reassembly", async () => {
  const payload = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"p' } }],
        },
      },
    ],
  });
  const out = [];
  for await (const c of chunksFromSSE(sse([payload]))) out.push(c);
  expect(out).toEqual([
    { toolCall: { index: 0, id: "c1", name: "read_file", argumentsDelta: '{"p' } },
  ]);
});

test("[DONE] terminates the stream", async () => {
  const out = [];
  for await (const c of chunksFromSSE(
    sse(["[DONE]", JSON.stringify({ choices: [{ delta: { content: "x" } }] })]),
  )) {
    out.push(c);
  }
  expect(out).toEqual([]);
});

test("malformed JSON is skipped rather than crashing the stream", async () => {
  const out = [];
  for await (const c of chunksFromSSE(
    sse(["{not json", JSON.stringify({ choices: [{ delta: { content: "ok" } }] })]),
  )) {
    out.push(c);
  }
  expect(out).toEqual([{ text: "ok" }]);
});
