// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the agent is, and what the project says about itself.
 *
 * Without this the model is dropped into a directory with no idea what it is
 * looking at. Asked what a project contains it globs, describes whatever came
 * back, and is confidently wrong whenever the answer was "a subdirectory of
 * something larger" — which in a monorepo is most of the time.
 *
 * Worse, the tools disagree. File tools are scoped to the working directory,
 * while `git` run through the shell walks up to the repository root on its
 * own. The model sees two different projects depending on which tool it
 * reaches for, and nothing tells it that is happening. Saying plainly where it
 * is, and where the repository is, costs a few dozen tokens and removes a
 * whole class of confident nonsense.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Files a project uses to brief an agent, in the order they are preferred.
 *
 * `AGENTS.md` is the emerging cross-tool convention and `CLAUDE.md` the
 * established one; `KUANG.md` is here so a project can say something to this
 * agent specifically without editing what it tells the others.
 */
const CONTEXT_FILES = ["KUANG.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * Most of a brief is useful; all of one is not, when it is sent every turn.
 * Large enough for a real project map, small enough to stay affordable.
 */
const MAX_CONTEXT_BYTES = 8000;

export interface ProjectContext {
  /** Where file tools are rooted. Always the working directory. */
  root: string;
  /** The enclosing repository, when the root sits inside one. */
  repoRoot?: string;
  /** The brief, if the project wrote one. */
  brief?: { path: string; text: string; truncated: boolean };
}

/** The nearest enclosing directory containing `.git`, if any. */
export function findRepoRoot(from: string): string | undefined {
  let current = resolve(from);

  for (;;) {
    // A worktree or submodule has `.git` as a file rather than a directory.
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Read a brief, preferring the working directory's over the repository's. */
function findBrief(root: string, repoRoot?: string): ProjectContext["brief"] {
  const places = repoRoot && repoRoot !== root ? [root, repoRoot] : [root];

  for (const place of places) {
    for (const name of CONTEXT_FILES) {
      const path = join(place, name);
      try {
        if (!statSync(path).isFile()) continue;
        const full = readFileSync(path, "utf-8");
        const truncated = full.length > MAX_CONTEXT_BYTES;
        return { path, text: truncated ? full.slice(0, MAX_CONTEXT_BYTES) : full, truncated };
      } catch {
        // Unreadable is the same as absent: a brief is a courtesy, never a
        // reason to refuse to start.
      }
    }
  }
  return undefined;
}

export function describeProject(cwd: string): ProjectContext {
  const root = resolve(cwd);
  const repoRoot = findRepoRoot(root);
  return { root, repoRoot, brief: findBrief(root, repoRoot) };
}

/**
 * The part of the system prompt that says where the agent is standing.
 *
 * The scoping sentence is the load-bearing one. A model told only its working
 * directory will still answer "what is in this project" with whatever `glob`
 * returned; told that its file tools stop at this directory and that the
 * repository extends above it, it says so instead.
 */
export function projectPrompt(context: ProjectContext): string {
  const lines = [`Working directory: ${context.root}`];

  if (context.repoRoot && context.repoRoot !== context.root) {
    const within = relative(context.repoRoot, context.root).replaceAll(sep, "/");
    lines.push(
      `This is ${within} inside a larger repository at ${context.repoRoot}. ` +
        `Your file tools reach only the working directory, so a search here ` +
        `sees that subdirectory alone and not the whole repository — say so ` +
        `rather than describing the part as if it were the whole. Shell ` +
        `commands run here too, though git will act on the whole repository.`,
    );
  } else if (context.repoRoot) {
    lines.push("This is the root of its git repository.");
  }

  if (context.brief) {
    lines.push(
      "",
      `The project describes itself in ${context.brief.path}${
        context.brief.truncated ? " (shown truncated)" : ""
      }:`,
      "",
      context.brief.text.trim(),
    );
  }

  return lines.join("\n");
}
