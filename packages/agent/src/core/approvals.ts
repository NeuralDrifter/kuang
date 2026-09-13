// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The consent gate for tool execution (spec §7).
 *
 * Deliberately called "approvals": `bl permission` already means *model*
 * permissions on the Bailian platform, and reusing the word would confuse two
 * unrelated systems.
 *
 * One derivation function does double duty. `patternFor` turns a call into a
 * rule, and `isAllowed` accepts a call only when its own derived pattern equals
 * a stored rule. So a call `patternFor` refuses to generalise — a command that
 * chains, a path that normalises outside the project, a root-level path — can
 * never be auto-approved either. Fail-closed is the default path, not a
 * special case, and there is exactly one function to audit.
 */

export type ApprovalDecision = "allow" | "allow_always" | "deny";

export interface ApprovalRule {
  tool: string;
  /** Derived by `patternFor`. A rule without one authorises nothing. */
  argPattern?: string;
}

/** The argument each tool is gated on. A tool absent here is never auto-approved. */
const GATED_ARG: Record<string, string> = {
  shell: "command",
  write_file: "path",
  edit_file: "path",
  read_file: "path",
};

/**
 * Characters that let one shell command become two. A command containing any
 * of them is never generalised into a rule, so an approved prefix cannot be
 * used as a launch pad: `pnpm test` approved must not permit
 * `pnpm test; rm -rf ~`.
 */
const SHELL_CHAINING = /[;&|`$(){}<>\n\r]/;

/**
 * Anchored glob match. `*` matches within a path segment, `**` across
 * segments. Exported for Task 8's `glob` tool; approvals themselves compare
 * derived patterns for equality rather than globbing.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  // Single pass, so `**` is consumed before `*` can match its first star.
  const source = "^" + escaped.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*")) + "$";
  return new RegExp(source).test(value);
}

/**
 * Normalise a path to forward slashes and resolve `.` / `..` segments.
 * Returns undefined for an absolute path, or one that climbs out of the
 * project — neither can be expressed as a project-relative rule.
 */
function normalizePath(raw: string): string | undefined {
  const slashed = raw.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return undefined;

  const out: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? undefined : out.join("/");
}

/** The value a rule for this call would be built from. */
function gatedValue(tool: string, args: Record<string, unknown>): string | undefined {
  const key = GATED_ARG[tool];
  if (key === undefined) return undefined;
  const raw = args[key];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Derive the rule this call generalises to, or undefined when it must never be
 * generalised. Used both to store a rule and to test one, so the two can never
 * disagree.
 *
 *  - shell: the first two words plus `*` — `pnpm test --run` -> `pnpm test*`;
 *    undefined when the command could chain.
 *  - paths: the containing directory plus `**`, after normalisation;
 *    undefined at the project root, so no rule can ever mean "any path".
 */
export function patternFor(tool: string, args: Record<string, unknown>): string | undefined {
  const value = gatedValue(tool, args);
  if (value === undefined) return undefined;

  if (tool === "shell") {
    if (SHELL_CHAINING.test(value)) return undefined;
    const parts = value.trim().split(/\s+/).filter(Boolean);
    const command = [];
    for (const part of parts) {
      if (part.startsWith("-")) break;
      command.push(part);
    }
    if (command.length === 0) return undefined;
    return command.join(" ") + "*";
  }

  const normalized = normalizePath(value);
  if (normalized === undefined) return undefined;
  const dir = normalized.split("/").slice(0, -1).join("/");
  if (dir === "") return undefined;
  return dir + "/**";
}

export class ApprovalStore {
  private ruleList: ApprovalRule[];

  constructor(rules: ApprovalRule[] = []) {
    this.ruleList = [...rules];
  }

  /**
   * Whether a stored rule covers this call. A call that cannot be generalised
   * is never covered, so malformed, chaining and escaping calls always prompt.
   */
  isAllowed(tool: string, args: Record<string, unknown>): boolean {
    const derived = patternFor(tool, args);
    if (derived === undefined) return false;
    return this.ruleList.some((rule) => rule.tool === tool && rule.argPattern === derived);
  }

  /** Persist a rule covering this call and calls like it, when one is derivable. */
  allowAlways(tool: string, args: Record<string, unknown>): void {
    const argPattern = patternFor(tool, args);
    if (argPattern === undefined) return;
    if (this.ruleList.some((r) => r.tool === tool && r.argPattern === argPattern)) return;
    this.ruleList.push({ tool, argPattern });
  }

  /** The current rules, for persistence to ~/.bailian/agent/approvals.json. */
  rules(): ApprovalRule[] {
    return [...this.ruleList];
  }
}
