// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Mouse reporting, parsed.
 *
 * Ink has no mouse support, so the terminal's SGR sequences arrive as ordinary
 * `useInput` text. Ink strips exactly one leading escape and hands the rest
 * over, which is why these tests feed the stripped form: that is what the
 * handler actually sees.
 */
import React from "react";
import { expect, test } from "vite-plus/test";
import { render, useInput } from "ink";
import { PassThrough, Writable } from "node:stream";
import {
  MOUSE_OFF,
  MOUSE_ON,
  paneForColumn,
  parseMouseEvents,
  wheelDelta,
} from "../src/ui/ink/mouse.ts";

/** The private modes a sequence sets (`h`) or clears (`l`). */
function modes(sequence: string, action: "h" | "l"): string[] {
  const pattern = new RegExp(`\\[\\?(\\d+)${action}`, "g");
  return [...sequence.matchAll(pattern)].map((m) => m[1]!).sort();
}

test("every mouse mode that gets turned on gets turned off again", () => {
  // A mode left on outlives the process: the terminal keeps reporting, and
  // the user's shell fills with escape sequences until they reset it.
  expect(modes(MOUSE_OFF, "l")).toEqual(modes(MOUSE_ON, "h"));
});

test("mouse reporting asks for button tracking and SGR coordinates", () => {
  // 1002 reports motion while a button is held, which is what makes
  // dragging the scrollbar possible; 1000 alone would only give press and
  // release. 1006 is SGR, which is the only encoding that survives past
  // column 223.
  expect(modes(MOUSE_ON, "h")).toEqual(["1002", "1006"]);
});

test("the wheel scrolls up toward the top and down toward the end", () => {
  // 64 and 65 are the SGR wheel buttons. Up must decrease the scroll
  // position, or the scrollbar and the wheel disagree about which way is up.
  expect(wheelDelta(64)).toBeLessThan(0);
  expect(wheelDelta(65)).toBeGreaterThan(0);
});

test("a click is not a wheel event", () => {
  expect(wheelDelta(0)).toBeUndefined();
  // 32 is motion with a button held, which drags rather than scrolls.
  expect(wheelDelta(32)).toBeUndefined();
});

test("the wheel still scrolls with a modifier held", () => {
  // SGR adds modifier bits to the button: shift +4, alt +8, ctrl +16. Testing
  // equality against 64/65 therefore missed every modified scroll, so
  // shift+wheel — a common habit — did nothing at all.
  expect(wheelDelta(64 + 4)).toBe(wheelDelta(64)); // shift + up
  expect(wheelDelta(65 + 4)).toBe(wheelDelta(65)); // shift + down
  expect(wheelDelta(64 + 16)).toBe(wheelDelta(64)); // ctrl + up
  expect(wheelDelta(65 + 8)).toBe(wheelDelta(65)); // alt + down
});

test("the column decides which pane the wheel is over", () => {
  // SGR columns are 1-based, and the split is the last column of the left
  // pane, so the boundary itself belongs to the left.
  expect(paneForColumn(1, 40)).toBe("conversation");
  expect(paneForColumn(40, 40)).toBe("conversation");
  expect(paneForColumn(41, 40)).toBe("tools");
});

/** The escape Ink leaves in front of every report after the first. */
const ESC = String.fromCharCode(27);

test("a wheel-up report becomes one event", () => {
  expect(parseMouseEvents("[<64;25;10M")).toEqual([
    { button: 64, column: 25, row: 10, pressed: true },
  ]);
});

test("a chunk holding several reports yields every one of them", () => {
  const chunk = `[<64;25;10M${ESC}[<64;25;11M${ESC}[<64;25;12M`;
  expect(parseMouseEvents(chunk).map((e) => e.row)).toEqual([10, 11, 12]);
});

/**
 * Feed raw bytes to a real Ink app and collect what `useInput` hands over.
 *
 * Ink reads with `on("readable")` and `read()`, not `on("data")`, and it runs
 * every chunk through its own input parser before `parseKeypress` sees it —
 * so nothing short of a real render answers whether a mouse report survives.
 */
async function throughInk(raw: string): Promise<string[]> {
  const seen: string[] = [];

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const stdout = new Writable({ write: (_c, _e, done) => done() }) as never;

  function Probe(): React.ReactElement | null {
    useInput((input) => void seen.push(input));
    return null;
  }

  const app = render(<Probe />, { stdin: stdin as never, stdout, patchConsole: false });
  stdin.write(raw);
  await new Promise((resolve) => setTimeout(resolve, 80));
  app.unmount();
  return seen;
}

test("an SGR mouse report survives Ink's input parsing", async () => {
  const seen = await throughInk(`${ESC}[<64;25;10M`);
  const events = seen.flatMap((input) => parseMouseEvents(input));

  expect(events).toEqual([{ button: 64, column: 25, row: 10, pressed: true }]);
});
