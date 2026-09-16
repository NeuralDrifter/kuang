// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowing where it is standing.
 *
 * The bug this exists for: asked what a project contained, the agent globbed
 * its working directory, got a subdirectory's worth of files, and described
 * them as the whole project. Meanwhile `git` run through the shell was
 * reporting on the repository above it. Two different projects, no sign to
 * the model that they differed.
 */
import { expect, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeProject, findRepoRoot, projectPrompt } from "../src/core/project.ts";

/** A repository with a package inside it, the shape that caused the bug. */
function monorepo(): { repo: string; pkg: string } {
  const repo = mkdtempSync(join(tmpdir(), "kuang-proj-"));
  mkdirSync(join(repo, ".git"));
  const pkg = join(repo, "packages", "cli");
  mkdirSync(pkg, { recursive: true });
  return { repo, pkg };
}

test("the repository root is found from a subdirectory", () => {
  const { repo, pkg } = monorepo();
  expect(findRepoRoot(pkg)).toBe(repo);
});

test("a directory outside any repository reports none", () => {
  expect(findRepoRoot(mkdtempSync(join(tmpdir(), "kuang-bare-")))).toBeUndefined();
});

test("a .git file is a repository too, not only a directory", () => {
  // Worktrees and submodules write `.git` as a file.
  const dir = mkdtempSync(join(tmpdir(), "kuang-wt-"));
  writeFileSync(join(dir, ".git"), "gitdir: /elsewhere", "utf-8");
  expect(findRepoRoot(dir)).toBe(dir);
});

test("the prompt says the working directory is part of something larger", () => {
  const { repo, pkg } = monorepo();
  const prompt = projectPrompt(describeProject(pkg));

  expect(prompt).toContain(pkg);
  expect(prompt).toContain(repo);
  // The load-bearing sentence: without it the model answers "what is in this
  // project" with whatever glob returned.
  expect(prompt).toContain("packages/cli inside a larger repository");
  expect(prompt).toContain("not the whole repository");
});

test("the prompt warns that git does not share the same scope", () => {
  const { pkg } = monorepo();
  // The agent read files from one project and git history from another.
  expect(projectPrompt(describeProject(pkg))).toContain("git will act on the whole repository");
});

test("at a repository root there is no confusing distinction to draw", () => {
  const { repo } = monorepo();
  const prompt = projectPrompt(describeProject(repo));
  expect(prompt).toContain("root of its git repository");
  expect(prompt).not.toContain("inside a larger repository");
});

// ── the project's own brief ─────────────────────────────────────────────────

test("a brief at the repository root is picked up from a subdirectory", () => {
  const { repo, pkg } = monorepo();
  writeFileSync(join(repo, "AGENTS.md"), "# contract\nRead this first.", "utf-8");

  expect(projectPrompt(describeProject(pkg))).toContain("Read this first.");
});

test("a brief beside the working directory wins over the repository's", () => {
  const { repo, pkg } = monorepo();
  writeFileSync(join(repo, "AGENTS.md"), "BRIEF-FROM-REPO-ROOT", "utf-8");
  writeFileSync(join(pkg, "AGENTS.md"), "BRIEF-FROM-PACKAGE", "utf-8");

  // The nearer one is the more specific, and specificity is the point.
  const prompt = projectPrompt(describeProject(pkg));
  expect(prompt).toContain("BRIEF-FROM-PACKAGE");
  expect(prompt).not.toContain("BRIEF-FROM-REPO-ROOT");
});

test("KUANG.md is preferred, so a project can address this agent alone", () => {
  const { repo } = monorepo();
  writeFileSync(join(repo, "CLAUDE.md"), "for another tool", "utf-8");
  writeFileSync(join(repo, "KUANG.md"), "for kuang", "utf-8");

  expect(projectPrompt(describeProject(repo))).toContain("for kuang");
});

test("CLAUDE.md is read when it is the only brief there is", () => {
  const { repo } = monorepo();
  writeFileSync(join(repo, "CLAUDE.md"), "existing convention", "utf-8");
  expect(projectPrompt(describeProject(repo))).toContain("existing convention");
});

test("a very long brief is truncated and says so", () => {
  const { repo } = monorepo();
  writeFileSync(join(repo, "AGENTS.md"), "x".repeat(20000), "utf-8");

  const context = describeProject(repo);
  // It is sent every turn, so all of one is not useful even when most is.
  expect(context.brief!.truncated).toBe(true);
  expect(context.brief!.text.length).toBeLessThan(20000);
  expect(projectPrompt(context)).toContain("truncated");
});

test("no brief is not a problem", () => {
  const { repo } = monorepo();
  const prompt = projectPrompt(describeProject(repo));
  expect(prompt).toContain(repo);
  expect(prompt).not.toContain("describes itself");
});
