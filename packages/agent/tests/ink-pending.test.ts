// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The bridge between a loop that awaits and a component that cannot be
 * awaited. What matters is that exactly one answer is ever delivered.
 */
import { expect, test } from "vite-plus/test";
import { ask } from "../src/ui/ink/pending.ts";

test("answering resolves what the loop is waiting on", async () => {
  const { question, answered } = ask<string>("Approve?");
  question.answer("allow");
  expect(await answered).toBe("allow");
});

test("a second answer is ignored", async () => {
  const { question, answered } = ask<string>("Approve?");
  question.answer("allow");
  question.answer("deny");

  // A component can re-render and fire a stale handler. Without the guard the
  // second answer would resolve a promise the loop had moved past, and land on
  // whatever it asked next.
  expect(await answered).toBe("allow");
});

test("the question carries what the UI needs to draw", () => {
  const { question } = ask<string>("write_file(a.ts)", "--- a.ts\n+++ a.ts\n+x");
  expect(question.prompt).toBe("write_file(a.ts)");
  expect(question.detail).toContain("+x");
});

test("detail is optional, for questions that are just a line", () => {
  expect(ask<string>("Passphrase:").question.detail).toBeUndefined();
});

test("nothing resolves until an answer is given", async () => {
  const { answered } = ask<string>("Approve?");
  const settled = await Promise.race([
    answered,
    new Promise((r) => setTimeout(() => r("still waiting"), 20)),
  ]);
  expect(settled).toBe("still waiting");
});
