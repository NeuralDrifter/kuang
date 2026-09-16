// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The editable prompt line.
 *
 * Extracted from the two Ink input handlers, which had grown nineteen
 * identical lines between them — so every cursor fix had to be made twice,
 * and the passphrase field was one missed edit away from behaving unlike the
 * prompt above it.
 */
import { expect, test } from "vite-plus/test";
import { editLine, type Line } from "../src/ui/ink/line.ts";

const at = (text: string, cursor: number): Line => ({ text, cursor });

test("typing inserts at the cursor and carries it along", () => {
  expect(editLine(at("ac", 1), "b", {})).toEqual(at("abc", 2));
});

test("a paste arrives as one input and lands whole", () => {
  // Ink hands a paste over as a single string; splitting it would be wrong.
  expect(editLine(at("", 0), "hello world", {})).toEqual(at("hello world", 11));
});

test("backspace takes the character behind the cursor", () => {
  expect(editLine(at("abc", 2), "", { backspace: true })).toEqual(at("ac", 1));
});

test("backspace at the start of the line does nothing", () => {
  expect(editLine(at("abc", 0), "", { backspace: true })).toEqual(at("abc", 0));
});

test("delete takes the character under the cursor and stays put", () => {
  expect(editLine(at("abc", 1), "", { delete: true })).toEqual(at("ac", 1));
});

test("delete at the end of the line does nothing", () => {
  expect(editLine(at("abc", 3), "", { delete: true })).toEqual(at("abc", 3));
});

test("the cursor moves but never leaves the line", () => {
  expect(editLine(at("abc", 1), "", { leftArrow: true })).toEqual(at("abc", 0));
  expect(editLine(at("abc", 0), "", { leftArrow: true })).toEqual(at("abc", 0));
  expect(editLine(at("abc", 2), "", { rightArrow: true })).toEqual(at("abc", 3));
  expect(editLine(at("abc", 3), "", { rightArrow: true })).toEqual(at("abc", 3));
});

test("a chord is a command, not text", () => {
  // Ctrl+O toggles the mouse and Ctrl+C leaves; neither should type a letter.
  expect(editLine(at("abc", 3), "o", { ctrl: true })).toEqual(at("abc", 3));
  expect(editLine(at("abc", 3), "v", { meta: true })).toEqual(at("abc", 3));
});

test("a keystroke it has no rule for leaves the line alone", () => {
  expect(editLine(at("abc", 1), "", {})).toEqual(at("abc", 1));
});
