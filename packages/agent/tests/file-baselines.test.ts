// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The file baselines behind the diff panel.
 *
 * One snapshot per file, taken at first touch, held for the session: the
 * second edit to a file must diff against its original, not against the
 * previous edit, or the folded view drifts from what the user approved.
 */
import { expect, test } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBaselines } from "../src/core/file-baselines.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "kuang-baselines-"));
}

test("capture remembers the content at first touch, and nothing later replaces it", async () => {
  const root = repo();
  const file = join(root, "a.ts");
  writeFileSync(file, "one\ntwo\n", "utf-8");

  const baselines = new FileBaselines(root);
  await baselines.capture("a.ts");

  // The file changes, then is touched again: the baseline must not move.
  writeFileSync(file, "one\nTWO\nthree\n", "utf-8");
  await baselines.capture("a.ts");

  expect(baselines.baselineOf("a.ts")).toBe("one\ntwo\n");
});

test("a file that does not exist yet has an empty baseline", async () => {
  const baselines = new FileBaselines(repo());
  await baselines.capture("brand-new.ts");
  expect(baselines.baselineOf("brand-new.ts")).toBe("");
});

test("readNow returns the file as it is, not as it was", async () => {
  const root = repo();
  writeFileSync(join(root, "a.ts"), "before\n", "utf-8");

  const baselines = new FileBaselines(root);
  await baselines.capture("a.ts");
  writeFileSync(join(root, "a.ts"), "after\n", "utf-8");

  expect(await baselines.readNow("a.ts")).toBe("after\n");
});

test("a path that escapes the project records nothing and does not throw", async () => {
  // The tools validate paths themselves and report failures through
  // tool_result; the baseline capture is a best-effort observer and must not
  // turn a bad path into a second, different failure in the loop.
  const baselines = new FileBaselines(repo());
  await baselines.capture("../outside.ts");
  expect(baselines.baselineOf("../outside.ts")).toBeUndefined();
});

test("a file deleted between capture and read is reported as unreadable", async () => {
  // The tool wrote it, then something outside the agent removed it: the diff
  // must be skipped rather than crash the turn. readNow says so with
  // undefined; the tool's own result already told the model what happened.
  const root = repo();
  writeFileSync(join(root, "a.ts"), "here\n", "utf-8");

  const baselines = new FileBaselines(root);
  await baselines.capture("a.ts");
  expect(await baselines.readNow("a.ts")).toBe("here\n");

  // Deleted out from under the session.
  rmSync(join(root, "a.ts"));
  expect(await baselines.readNow("a.ts")).toBeUndefined();
});
