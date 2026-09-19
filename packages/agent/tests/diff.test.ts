// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * File diffs.
 *
 * The diff these replace paired lines by index, so a single inserted line
 * reported every line below it as changed. That was survivable in an approval
 * box read once; the panel shows a diff per edit and is read properly, which
 * is exactly where index pairing falls apart.
 */
import { expect, test } from "vite-plus/test";
import { diffFiles } from "../src/core/diff.ts";

/** The `-`/`+` lines of a diff, without its file header. */
function changes(diff: string): string[] {
  return diff.split("\n").filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+)/.test(line));
}

test("an inserted line does not mark the rest of the file as changed", () => {
  // The whole reason for replacing the old diff.
  const before = "one\ntwo\nthree\n";
  const after = "zero\none\ntwo\nthree\n";

  const { diff, added, removed } = diffFiles(before, after, "a.ts");

  expect(changes(diff)).toEqual(["+zero"]);
  expect(added).toBe(1);
  expect(removed).toBe(0);
});

test("a deleted line is reported alone", () => {
  const { diff, added, removed } = diffFiles("one\ntwo\nthree\n", "one\nthree\n", "a.ts");

  expect(changes(diff)).toEqual(["-two"]);
  expect(added).toBe(0);
  expect(removed).toBe(1);
});

test("a replaced line counts as one of each", () => {
  const { added, removed } = diffFiles("one\ntwo\n", "one\nTWO\n", "a.ts");

  expect(added).toBe(1);
  expect(removed).toBe(1);
});

test("an unchanged file produces no changes", () => {
  const same = "one\ntwo\n";
  const { diff, added, removed } = diffFiles(same, same, "a.ts");

  expect(changes(diff)).toEqual([]);
  expect(added).toBe(0);
  expect(removed).toBe(0);
});

test("the diff names the file it describes", () => {
  // The panel groups by path, and an approval prompt has to say what it is
  // about to change.
  const { diff } = diffFiles("one\n", "two\n", "src/deep/a.ts");
  expect(diff).toContain("src/deep/a.ts");
});

test("a new file is all additions", () => {
  const { added, removed } = diffFiles("", "one\ntwo\n", "a.ts");

  expect(added).toBe(2);
  expect(removed).toBe(0);
});
