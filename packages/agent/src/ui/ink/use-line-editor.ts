// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The prompt's editing state: one line, plus the lines submitted before it.
 *
 * Split out of `app.tsx`, which had grown to own the transcript, the layout,
 * the scrolling, the mouse and this as well. Text and cursor live in one
 * object because they only ever move together — holding them apart is what
 * let the two input handlers drift.
 */
import { useState } from "react";
import { editLine, type EditKeys, type Line } from "./line.ts";

const EMPTY: Line = { text: "", cursor: 0 };

export interface LineEditor {
  text: string;
  cursor: number;
  /** Apply one keystroke. */
  edit: (input: string, key: EditKeys) => void;
  /**
   * Take the line exactly as typed and reset.
   *
   * Deliberately not trimmed: a stray space before a command is a slip worth
   * forgiving, but a passphrase is not, and trimming one silently changes the
   * secret that seals the vault.
   */
  take: () => string;
  /** Put `text` into the history, ready to be walked back to. */
  remember: (text: string) => void;
  /** Step back through what was submitted, stashing the half-typed line. */
  older: () => void;
  /** Step forward again, ending on the stashed line. */
  newer: () => void;
}

export function useLineEditor(): LineEditor {
  const [line, setLine] = useState<Line>(EMPTY);
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [stashed, setStashed] = useState("");

  /** Move to a line from history, cursor at its end where typing resumes. */
  const show = (text: string): void => setLine({ text, cursor: text.length });

  return {
    text: line.text,
    cursor: line.cursor,

    edit: (input, key) => setLine((current) => editLine(current, input, key)),

    take: () => {
      setLine(EMPTY);
      return line.text;
    },

    remember: (text) => {
      setHistory((current) => {
        const next = [...current, text];
        setIndex(next.length);
        return next;
      });
      setStashed("");
    },

    older: () => {
      if (index === 0) return;
      // Stepping off the live line for the first time stashes it, so walking
      // back down returns what was being typed rather than losing it.
      if (index === history.length) setStashed(line.text);
      setIndex(index - 1);
      show(history[index - 1]!);
    },

    newer: () => {
      if (index >= history.length) return;
      const next = index + 1;
      setIndex(next);
      show(next === history.length ? stashed : history[next]!);
    },
  };
}
