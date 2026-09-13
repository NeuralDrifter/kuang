// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The consent gate for tool execution (spec §7).
 *
 * Deliberately called "approvals": `bl permission` already means *model*
 * permissions on the Bailian platform, and reusing the word would confuse two
 * unrelated systems.
 *
 * "Always allow" persists a *pattern*, never the literal invocation — approving
 * `pnpm test --run` once should not re-prompt for `pnpm test --watch`. Patterns
 * are anchored at the start so an approved prefix can never be smuggled into
 * the middle of a longer command.
 */

export type ApprovalDecision = "allow" | "allow_always" | "deny";

export interface ApprovalRule {
  tool: string;
  /** Glob over the tool's significant argument. Absent means "any arguments". */
  argPattern?: string;
}

/** The argument each tool is gated on. */
const GATED_ARG: Record<string, string> = {
  shell: "command",
  write_file: "path",
  edit_file: "path",
  read_file: "path",
};

/**
 * Anchored glob match. `*` matches within a path segment, `**` across
 * segments. Anchored at both ends so `pnpm test*` cannot match
 * `rm -rf / && pnpm test`.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source =
    // Single pass, so `**` is consumed before `*` can match its first star.
    "^" + escaped.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*")) + "$";
  return new RegExp(source).test(value);
}

/** The value an "always allow" rule for this call should be built from. */
function gatedValue(tool: string, args: Record<string, unknown>): string | undefined {
  const key = GATED_ARG[tool];
  if (!key) return undefined;
  const raw = args[key];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Derive the pattern "always allow" should store.
 *  - shell: the first two words plus `*` — `pnpm test --run` -> `pnpm test*`
 *  - paths: the containing directory plus `**`
 */
export function patternFor(tool: string, args: Record<string, unknown>): string | undefined {
  const value = gatedValue(tool, args);
  if (value === undefined) return undefined;

  if (tool === "shell") {
    const words = value.trim().split(/\s+/).slice(0, 2);
    return words.join(" ") + "*";
  }
  const dir = value.replaceAll("\\", "/").split("/").slice(0, -1).join("/");
  return dir === "" ? "**" : dir + "/**";
}

export class ApprovalStore {
  private ruleList: ApprovalRule[];

  constructor(rules: ApprovalRule[] = []) {
    this.ruleList = [...rules];
  }

  /** Whether a previously granted rule covers this call. */
  isAllowed(tool: string, args: Record<string, unknown>): boolean {
    const value = gatedValue(tool, args);
    return this.ruleList.some((rule) => {
      if (rule.tool !== tool) return false;
      if (rule.argPattern === undefined) return true;
      return value !== undefined && matchesPattern(rule.argPattern, value);
    });
  }

  /** Persist a pattern covering this call and calls like it. */
  allowAlways(tool: string, args: Record<string, unknown>): void {
    const argPattern = patternFor(tool, args);
    if (this.ruleList.some((r) => r.tool === tool && r.argPattern === argPattern)) return;
    this.ruleList.push({ tool, argPattern });
  }

  /** The current rules, for persistence to ~/.bailian/agent/approvals.json. */
  rules(): ApprovalRule[] {
    return [...this.ruleList];
  }
}
