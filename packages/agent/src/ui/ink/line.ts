// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * One editable line of input, and the keystrokes that change it.
 *
 * The prompt and the passphrase field each used to carry their own copy of
 * this — nineteen identical lines — so a cursor fix had to be made in both,
 * and the two were one missed edit away from disagreeing.
 *
 * Pure, and it names only the key fields it reads rather than importing
 * Ink's `Key`: it can then be tested with plain objects, and the renderer
 * stays the only thing that knows Ink exists.
 */

export interface Line {
  text: string;
  /** Where the next character lands, from 0 to `text.length`. */
  cursor: number;
}

/** The subset of a key event that editing cares about. Ink's `Key` fits it. */
export interface EditKeys {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** Apply one keystroke. Anything it has no rule for leaves the line alone. */
export function editLine(line: Line, input: string, key: EditKeys): Line {
  const { text, cursor } = line;

  if (key.leftArrow) return { text, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { text, cursor: Math.min(text.length, cursor + 1) };

  if (key.backspace) {
    if (cursor === 0) return line;
    return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
  }

  if (key.delete) {
    if (cursor === text.length) return line;
    return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
  }

  // Ink hands a paste over as one `input` string, so this inserts the whole
  // block rather than a character — which is what keeps a paste intact.
  if (input && !key.ctrl && !key.meta) {
    return {
      text: text.slice(0, cursor) + input + text.slice(cursor),
      cursor: cursor + input.length,
    };
  }

  return line;
}
