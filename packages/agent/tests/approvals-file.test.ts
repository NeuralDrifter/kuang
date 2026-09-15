// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Persisted approvals. The property under test throughout is that an answer
 * given in one project never applies in another — persistence is what makes
 * that matter, because before it every rule died within the hour.
 */
import { expect, test } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApprovalStore, type ApprovalRule } from "../src/core/approvals.ts";
import { loadApprovals, saveApprovals } from "../src/core/approvals-file.ts";

function file(): string {
  return join(mkdtempSync(join(tmpdir(), "kuang-appr-")), "approvals.json");
}

const RULE: ApprovalRule = { tool: "shell", argPattern: "pnpm test*" };

test("a saved rule comes back for the same project", () => {
  const path = file();
  saveApprovals("/work/repo", [RULE], path);
  expect(loadApprovals("/work/repo", path)).toEqual([RULE]);
});

test("a rule approved in one project does not apply in another", () => {
  const path = file();
  saveApprovals("/work/mine", [RULE], path);

  // `pnpm test*` means something different in a repository cloned an hour ago.
  expect(loadApprovals("/work/cloned-from-a-stranger", path)).toEqual([]);
});

test("saving one project leaves the others intact", () => {
  const path = file();
  saveApprovals("/work/a", [RULE], path);
  saveApprovals("/work/b", [{ tool: "shell", argPattern: "cargo build*" }], path);

  // Two agents in two repositories must not overwrite each other.
  expect(loadApprovals("/work/a", path)).toEqual([RULE]);
  expect(loadApprovals("/work/b", path)).toEqual([{ tool: "shell", argPattern: "cargo build*" }]);
});

test("a missing file is an empty rule set, not an error", () => {
  expect(loadApprovals("/work/repo", join(tmpdir(), "does-not-exist-12345.json"))).toEqual([]);
});

test("a damaged file loses the rules rather than stopping the agent", () => {
  const path = file();
  writeFileSync(path, "{{{ not json", "utf-8");

  // Being asked again is a nuisance; refusing to launch is a failure.
  expect(loadApprovals("/work/repo", path)).toEqual([]);
});

test("a file from an unknown version is ignored rather than guessed at", () => {
  const path = file();
  const key = resolve("/work/repo");
  writeFileSync(path, JSON.stringify({ version: 99, projects: { [key]: [RULE] } }), "utf-8");

  // Misreading a future shape could widen a permission. Fail closed.
  expect(loadApprovals("/work/repo", path)).toEqual([]);
});

test("a rule without a pattern is discarded on the way in", () => {
  const path = file();
  const key = resolve("/work/repo");
  writeFileSync(
    path,
    JSON.stringify({ version: 1, projects: { [key]: [{ tool: "shell" }, RULE] } }),
    "utf-8",
  );

  // A rule with no pattern authorises nothing, so it must not look like a rule.
  expect(loadApprovals("/work/repo", path)).toEqual([RULE]);
});

test("junk in place of a project's rules is survived", () => {
  const path = file();
  const key = resolve("/work/repo");
  writeFileSync(path, JSON.stringify({ version: 1, projects: { [key]: "nonsense" } }), "utf-8");
  expect(loadApprovals("/work/repo", path)).toEqual([]);
});

test("path spellings that differ are treated as different projects", () => {
  const path = file();
  saveApprovals("/work/repo", [RULE], path);

  // Being wrong here means being asked again, which is the safe direction.
  expect(loadApprovals("/work/repo/sub/..", path)).toEqual([RULE]);
  expect(loadApprovals("/work/other", path)).toEqual([]);
});

test("clearing a project's rules removes it rather than leaving an empty entry", () => {
  const path = file();
  saveApprovals("/work/repo", [RULE], path);
  saveApprovals("/work/repo", [], path);

  expect(loadApprovals("/work/repo", path)).toEqual([]);
});

// ── wired to the store ──────────────────────────────────────────────────────

test("answering always writes the rule out immediately", () => {
  const path = file();
  const store = new ApprovalStore(loadApprovals("/work/repo", path), (rules) =>
    saveApprovals("/work/repo", rules, path),
  );

  store.allowAlways("shell", { command: "pnpm test --run" });

  // Saved now, not at exit: sessions are usually lost, not closed.
  expect(loadApprovals("/work/repo", path)).toEqual([{ tool: "shell", argPattern: "pnpm test*" }]);
});

test("a rule that cannot be derived is never written", () => {
  const path = file();
  const store = new ApprovalStore([], (rules) => saveApprovals("/work/repo", rules, path));

  store.allowAlways("shell", { command: "rm -rf /" });
  store.allowAlways("shell", { command: "sudo anything" });

  // The denylist and the verb rule must hold across a restart too, or
  // persistence reopens exactly what Task 2 closed.
  expect(loadApprovals("/work/repo", path)).toEqual([]);
});

test("a rule survives a new store built from disk", () => {
  const path = file();
  const first = new ApprovalStore([], (rules) => saveApprovals("/work/repo", rules, path));
  first.allowAlways("shell", { command: "pnpm test --run" });

  const second = new ApprovalStore(loadApprovals("/work/repo", path));
  expect(second.isAllowed("shell", { command: "pnpm test --watch" })).toBe(true);
  expect(second.isAllowed("shell", { command: "rm -rf /" })).toBe(false);
});

test("a store without a change hook writes nothing anywhere", () => {
  const store = new ApprovalStore();
  store.allowAlways("shell", { command: "pnpm test" });
  expect(store.rules()).toHaveLength(1);
});
