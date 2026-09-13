// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { ApprovalStore, matchesPattern, patternFor } from "../src/core/approvals.ts";

test("glob patterns match prefixes, not arbitrary substrings", () => {
  expect(matchesPattern("pnpm test*", "pnpm test --run")).toBe(true);
  expect(matchesPattern("pnpm test*", "pnpm testing")).toBe(true);
  expect(matchesPattern("pnpm test*", "rm -rf / && pnpm test")).toBe(false);
  expect(matchesPattern("src/**", "src/a/b.ts")).toBe(true);
  expect(matchesPattern("src/**", "other/a.ts")).toBe(false);
});

test("an empty store allows nothing", () => {
  const store = new ApprovalStore([]);
  expect(store.isAllowed("shell", { command: "ls" })).toBe(false);
});

test("allow_always persists a pattern, not the literal invocation", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "pnpm test --run" });

  expect(store.isAllowed("shell", { command: "pnpm test --run" })).toBe(true);
  expect(store.isAllowed("shell", { command: "pnpm test --watch" })).toBe(true);
  expect(store.isAllowed("shell", { command: "rm -rf /" })).toBe(false);
});

test("an allowlist entry does not leak across tools", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "pnpm test" });
  expect(store.isAllowed("write_file", { path: "pnpm test" })).toBe(false);
});

test("patternFor derives a command prefix for shell and a directory glob for writes", () => {
  expect(patternFor("shell", { command: "pnpm test --run" })).toBe("pnpm test*");
  expect(patternFor("write_file", { path: "src/core/a.ts" })).toBe("src/core/**");
});

test("rules round-trip for persistence", () => {
  const store = new ApprovalStore([{ tool: "shell", argPattern: "git status*" }]);
  expect(store.isAllowed("shell", { command: "git status --short" })).toBe(true);
  expect(store.rules()).toEqual([{ tool: "shell", argPattern: "git status*" }]);
});
