// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { collect } from "../src/core/events.ts";

test("collect records events in order", () => {
  const { sink, events } = collect();
  sink({ type: "turn_start" });
  sink({ type: "text_delta", text: "hi" });
  sink({ type: "turn_end", usage: { promptTokens: 1, completionTokens: 2 } });

  expect(events.map((e) => e.type)).toEqual(["turn_start", "text_delta", "turn_end"]);
});

test("collected text deltas can be reassembled", () => {
  const { sink, events } = collect();
  sink({ type: "text_delta", text: "Hello, " });
  sink({ type: "text_delta", text: "world" });

  const text = events
    .filter((e): e is Extract<typeof e, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  expect(text).toBe("Hello, world");
});
