// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import type { Pane } from "./scroll.ts";

const ESC = String.fromCharCode(27);

/**
 * Ask the terminal to report the mouse.
 *
 * 1002 is button-event tracking: press, release, and motion while a button is
 * held — the last of which is what makes dragging a scrollbar possible, and
 * what plain 1000 does not give. 1006 switches the reply to SGR, which is the
 * only encoding that still works past column 223.
 */
export const MOUSE_ON = `${ESC}[?1002h${ESC}[?1006h`;

/**
 * Give the mouse back, in the reverse order it was taken.
 *
 * This has to run on the way out as well as on toggle. A mode left on
 * outlives the process: the terminal keeps reporting into whatever runs next,
 * and the user sees escape sequences in their shell until they reset it.
 */
export const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l`;

/** Set on every wheel report, whatever else is held down. */
const WHEEL_BIT = 64;

/** Clear for a scroll up, set for a scroll down. */
const DIRECTION_BIT = 1;

/** Rows per notch. Three is the usual terminal convention. */
const NOTCH = 3;

/**
 * How far a wheel report scrolls, or undefined when it is not the wheel.
 *
 * Read as bits rather than compared to 64 and 65, because SGR adds the held
 * modifiers into the same byte — shift 4, alt 8, ctrl 16. Matching exact
 * values meant shift+wheel arrived as 68, matched nothing, and scrolled
 * nowhere.
 *
 * Up is negative because the scroll position counts rows from the top of the
 * content, so scrolling up moves toward zero.
 */
export function wheelDelta(button: number): number | undefined {
  if ((button & WHEEL_BIT) === 0) return undefined;
  return (button & DIRECTION_BIT) === 0 ? -NOTCH : NOTCH;
}

/**
 * The pane a column falls in. Columns are 1-based, and `splitColumn` is the
 * last column of the left pane, so the boundary belongs to the left.
 */
export function paneForColumn(column: number, splitColumn: number): Pane {
  return column <= splitColumn ? "conversation" : "tools";
}

/** One mouse report from the terminal. */
export interface MouseReport {
  button: number;
  column: number;
  row: number;
  pressed: boolean;
}

/**
 * Global, because one `data` chunk can carry several reports: a fast wheel
 * outruns the read, and Ink strips only the first escape, so the rest arrive
 * still prefixed.
 */
const REPORT = /\[<(\d+);(\d+);(\d+)([Mm])/g;

export function parseMouseEvents(input: string): MouseReport[] {
  const events: MouseReport[] = [];
  for (const match of input.matchAll(REPORT)) {
    events.push({
      button: Number(match[1]),
      column: Number(match[2]),
      row: Number(match[3]),
      pressed: match[4] === "M",
    });
  }
  return events;
}
