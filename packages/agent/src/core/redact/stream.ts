// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Restores redacted values in a stream, without ever printing half a
 * placeholder.
 *
 * The model's reply arrives in chunks that split wherever the tokeniser
 * happened to land, so `[REDACTED_CARD_1]` routinely straddles two of them. A
 * naive restore per chunk would print `[REDACTED_CA` to the screen and then
 * `RD_1]`, and the user would see the machinery instead of their data.
 *
 * So anything that could still become a placeholder is held back until it
 * either completes or proves it is not one. Ported from the prototype, whose
 * buffering logic was the one part worth keeping — generalised here because
 * placeholders now carry a rule name rather than a fixed `PII` label.
 */
import type { Vault } from "./vault.ts";

/**
 * Longest a held fragment may grow before it is released as ordinary text. A
 * model can emit `[REDACTED_` and then keep talking; without this the buffer
 * grows without limit and the output stalls.
 */
const MAX_HELD = 64;

const PREFIX = "[REDACTED_";

/** Whether `suffix` could still turn into a placeholder given more input. */
function couldBecomePlaceholder(suffix: string): boolean {
  // Still partway through the fixed prefix, e.g. `[RED`.
  if (PREFIX.startsWith(suffix)) return true;
  // Past the prefix, accumulating the rule name and number, no `]` yet.
  return /^\[REDACTED_[A-Z_]*\d*$/.test(suffix);
}

export class StreamRestorer {
  private buffer = "";

  constructor(private readonly vault: Vault) {}

  /** Feed one chunk; returns everything now safe to display. */
  push(chunk: string): string {
    this.buffer = this.vault.restore(this.buffer + chunk);

    const lastOpen = this.buffer.lastIndexOf("[");
    if (lastOpen === -1) return this.take();

    const suffix = this.buffer.slice(lastOpen);
    // A fragment that cannot complete, or has grown implausibly long, is just
    // text — release it rather than holding output hostage to a stray bracket.
    if (!couldBecomePlaceholder(suffix) || suffix.length > MAX_HELD) return this.take();

    const safe = this.buffer.slice(0, lastOpen);
    this.buffer = suffix;
    return safe;
  }

  /** Release whatever is left, restoring what can be restored. */
  flush(): string {
    const rest = this.vault.restore(this.buffer);
    this.buffer = "";
    return rest;
  }

  private take(): string {
    const all = this.buffer;
    this.buffer = "";
    return all;
  }
}
