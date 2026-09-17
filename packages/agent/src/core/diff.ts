// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * File diffs, and the only place `jsdiff` is named.
 *
 * Wrapped rather than used directly so the library's types never reach `ui/`
 * and it can be replaced without touching anything else. The diff it replaces
 * paired lines by index, so one inserted line reported every line below it as
 * changed — tolerable in an approval box, useless in a panel that folds every
 * edit to a file into a single diff against the original.
 */
import { structuredPatch, formatPatch } from "diff";

export interface FileDiff {
  /** Unified diff, or an empty string when nothing changed. */
  diff: string;
  added: number;
  removed: number;
}

export function diffFiles(before: string, after: string, path: string): FileDiff {
  const patch = structuredPatch(path, path, before, after);

  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }

  // An unchanged file still yields a patch with headers and no hunks. Callers
  // ask "what changed", so that is nothing rather than two lines of preamble.
  const diff = patch.hunks.length === 0 ? "" : formatPatch(patch);

  return { diff, added, removed };
}
