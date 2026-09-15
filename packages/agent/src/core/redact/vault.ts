// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Holds the real values so the model never sees them.
 *
 * Sensitive text is replaced with a labelled placeholder on the way to the
 * model, and put back on the way out — to the screen, and to any tool about to
 * act on it. The model reasons about `[REDACTED_CARD_1]`; the user reads their
 * actual card number, and a file written back gets the real digits.
 *
 * Placeholders are **stable per value** for the life of the session. The same
 * card is always `[REDACTED_CARD_1]`, so the model can still deduplicate,
 * group and refer back across turns — it just cannot read the contents.
 *
 * Over-redaction is therefore cheap: a value the model only copies through is
 * restored intact and nobody notices. The cost that matters is that the model
 * is blind to the *contents*, so the system prompt tells it to say so rather
 * than guess when a task needs them.
 */
import { findMatches } from "./rules.ts";

/**
 * The placeholder format, in one place.
 *
 * The shape was previously known to three pieces of code — the scanning regex,
 * the template that builds one, and index arithmetic that picked the rule id
 * back out. Changing the format meant finding all three.
 */
const PREFIX = "[REDACTED_";
const SUFFIX = "]";

/** Issued placeholders match this exactly — case-sensitive, numbered. */
const PLACEHOLDER = /\[REDACTED_[A-Z_]+_\d+\]/g;

function placeholderText(ruleId: string, n: number): string {
  return `${PREFIX}${ruleId}_${n}${SUFFIX}`;
}

/** The rule a placeholder was issued for. Rule ids may contain underscores. */
function ruleIdOf(placeholder: string): string {
  return placeholder.slice(PREFIX.length, placeholder.lastIndexOf("_"));
}

/** A vault's contents, as persisted. Holds real values — handle accordingly. */
export interface VaultSnapshot {
  /** Placeholder -> real value. */
  values: Record<string, string>;
  /** Next number issued per rule, so a resume cannot reissue one. */
  counters: Record<string, number>;
}

export interface SanitizeResult {
  text: string;
  /** Occurrences replaced in this call, by rule id. For the user-facing notice. */
  found: Record<string, number>;
}

export class Vault {
  /** Real value -> placeholder, so one value always gets one placeholder. */
  private readonly toPlaceholder = new Map<string, string>();
  /** Placeholder -> real value, for restoration. */
  private readonly toValue = new Map<string, string>();
  /** Next number per rule id. */
  private readonly counters = new Map<string, number>();

  private on: boolean;

  constructor(enabled = true) {
    this.on = enabled;
  }

  get enabled(): boolean {
    return this.on;
  }

  /**
   * Turn redaction on or off mid-session. Disabling stops new values being
   * captured but never strands placeholders already issued — the model may
   * still be holding them, and they must keep restoring.
   */
  setEnabled(on: boolean): void {
    this.on = on;
  }

  /** Replace every validated match with its stable placeholder. */
  sanitize(text: string): SanitizeResult {
    if (!this.on) return { text, found: {} };

    const matches = findMatches(text);
    if (matches.length === 0) return { text, found: {} };

    const found: Record<string, number> = {};
    let out = "";
    let cursor = 0;

    for (const match of matches) {
      out += text.slice(cursor, match.start) + this.placeholderFor(match.value, match.ruleId);
      cursor = match.end;
      found[match.ruleId] = (found[match.ruleId] ?? 0) + 1;
    }
    out += text.slice(cursor);

    return { text: out, found };
  }

  /**
   * Put the real values back.
   *
   * A placeholder this vault never issued is left exactly as written: the model
   * can invent one, and replacing it with nothing would silently delete text
   * the user is about to read or write to a file.
   */
  restore(text: string): string {
    if (this.toValue.size === 0) return text;
    return text.replace(PLACEHOLDER, (token) => this.toValue.get(token) ?? token);
  }

  /**
   * Placeholders in `text` that this vault cannot resolve.
   *
   * `restore` leaves an unknown placeholder as written, which is right for
   * display — blanking it would delete text the user is about to read. It is
   * wrong for a tool argument: writing the literal `[REDACTED_CARD_99]` into a
   * config file is silent corruption. Callers about to act on restored text
   * ask here first.
   *
   * A model can invent one; and once sessions resume, a placeholder issued
   * before a restart will outlive the vault that knew its value.
   */
  unresolved(text: string): string[] {
    const found = text.match(PLACEHOLDER) ?? [];
    return [...new Set(found.filter((token) => !this.toValue.has(token)))];
  }

  /**
   * Everything needed to rebuild this vault, for callers that persist it.
   *
   * This is the one method that hands out real values, which is why it is
   * named plainly rather than as a getter: `snapshot()` at a call site should
   * read as "I am about to handle secrets".
   */
  snapshot(): VaultSnapshot {
    return {
      values: Object.fromEntries(this.toValue),
      counters: Object.fromEntries(this.counters),
    };
  }

  /**
   * Merge a snapshot back in. Existing entries win: a value captured in this
   * session is current, and a restored one may be stale.
   */
  absorb(snapshot: VaultSnapshot): void {
    for (const [placeholder, value] of Object.entries(snapshot.values)) {
      if (this.toValue.has(placeholder)) continue;
      this.toValue.set(placeholder, value);
      this.toPlaceholder.set(value, placeholder);
    }
    for (const [rule, n] of Object.entries(snapshot.counters)) {
      // Never reuse a number: continuing from the higher of the two keeps
      // placeholders unique across a resume.
      this.counters.set(rule, Math.max(this.counters.get(rule) ?? 0, n));
    }
  }

  /** Distinct values held, overall and by rule. */
  stats(): { total: number; byRule: Record<string, number> } {
    const byRule: Record<string, number> = {};
    for (const placeholder of this.toValue.keys()) {
      const id = ruleIdOf(placeholder);
      byRule[id] = (byRule[id] ?? 0) + 1;
    }
    return { total: this.toValue.size, byRule };
  }

  private placeholderFor(value: string, ruleId: string): string {
    const existing = this.toPlaceholder.get(value);
    if (existing) return existing;

    const next = (this.counters.get(ruleId) ?? 0) + 1;
    this.counters.set(ruleId, next);

    const placeholder = placeholderText(ruleId, next);
    this.toPlaceholder.set(value, placeholder);
    this.toValue.set(placeholder, value);
    return placeholder;
  }
}
