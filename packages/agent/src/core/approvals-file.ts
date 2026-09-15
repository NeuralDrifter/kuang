// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Approval rules on disk, keyed by project.
 *
 * **Rules are scoped to a project root and never shared between them.**
 * `pnpm test*` is a different proposition in a repository you wrote and one
 * you cloned an hour ago, and an answer given in the first must not silently
 * apply in the second. Scoping is by construction: a store is built from one
 * project's rules, so there is no code path that could consult another's.
 *
 * Path keys are compared exactly, after `resolve`. Two spellings of the same
 * directory therefore look like two projects and the rules simply do not
 * apply — which is the safe direction to be wrong in, and the reason no
 * cleverness with case folding or `realpath` is attempted here.
 */
import { resolve } from "node:path";
import type { ApprovalRule } from "./approvals.ts";
import { approvalsPath } from "./paths.ts";
import { readVersioned, writeJson } from "./store.ts";

/** Bumped only when the shape changes incompatibly. */
const VERSION = 1;

interface ApprovalsFile {
  version: number;
  /** Absolute project root -> the rules approved inside it. */
  projects: Record<string, ApprovalRule[]>;
}

/**
 * A *fresh* empty file every time. A shared constant here would be mutated by
 * `saveApprovals`, and every later read that fell back to it would inherit
 * another project's rules — the exact cross-project leak this module exists to
 * prevent, arriving through the back door.
 */
function empty(): ApprovalsFile {
  return { version: VERSION, projects: {} };
}

/** A rule is only usable if it carries a pattern; anything else authorises nothing. */
function usable(value: unknown): value is ApprovalRule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Partial<ApprovalRule>;
  return typeof rule.tool === "string" && typeof rule.argPattern === "string";
}

/**
 * Read the file, or the empty set when it is absent, damaged, or written by a
 * version this build does not understand.
 */
function load(path: string): ApprovalsFile {
  const file = readVersioned<ApprovalsFile>(
    path,
    VERSION,
    (record) => typeof record.projects === "object" && record.projects !== null,
  );
  return file ? { version: VERSION, projects: file.projects } : empty();
}

/** The rules approved for `projectRoot`, ignoring anything malformed. */
export function loadApprovals(projectRoot: string, path: string = approvalsPath()): ApprovalRule[] {
  const stored = load(path).projects[resolve(projectRoot)];
  if (!Array.isArray(stored)) return [];
  return stored.filter(usable);
}

/**
 * Replace the rules for `projectRoot`, leaving every other project's alone —
 * two agents in two repositories must not overwrite each other's answers.
 */
export function saveApprovals(
  projectRoot: string,
  rules: ApprovalRule[],
  path: string = approvalsPath(),
): void {
  const file = load(path);
  const key = resolve(projectRoot);

  const keep = rules.filter(usable);
  if (keep.length === 0) delete file.projects[key];
  else file.projects[key] = keep;

  writeJson(path, file);
}
