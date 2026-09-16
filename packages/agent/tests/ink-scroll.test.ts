// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Scrollbar geometry.
 *
 * Kept as arithmetic rather than a component so the awkward cases — content
 * that fits, a track shorter than its content, the last row — can be pinned
 * down without rendering anything.
 */
import { expect, test } from "vite-plus/test";
import { clampScroll, scrollTopForTrackRow, thumb } from "../src/ui/ink/scroll.ts";

test("grabbing the top of the track scrolls to the top", () => {
  expect(scrollTopForTrackRow(0, 10, 20, 10)).toBe(0);
});

test("grabbing the bottom of the track scrolls to the end", () => {
  // The last row must reach the very end, or the bottom of the transcript
  // is unreachable by dragging.
  expect(scrollTopForTrackRow(9, 10, 20, 10)).toBe(10);
});

test("grabbing the middle of the track lands in the middle", () => {
  expect(scrollTopForTrackRow(5, 11, 30, 10)).toBe(10);
});

test("a track with one row cannot divide by zero", () => {
  expect(scrollTopForTrackRow(0, 1, 20, 10)).toBe(0);
});

test("scrolling back past the top stops at the top", () => {
  // The panes used to subtract an unbounded offset from a list length and
  // slice with the result. Once that went negative the slice counted from
  // the end instead, and content that had scrolled away reappeared.
  expect(clampScroll(-40, 20, 10)).toBe(0);
});

test("scrolling forward past the end stops at the last screenful", () => {
  expect(clampScroll(999, 20, 10)).toBe(10);
});

test("content shorter than the viewport cannot scroll at all", () => {
  expect(clampScroll(5, 3, 10)).toBe(0);
});

test("content that fits fills the whole track", () => {
  expect(thumb({ contentRows: 4, viewportRows: 10, scrollTop: 0, trackRows: 10 })).toEqual({
    start: 0,
    size: 10,
  });
});

test("the thumb takes the share of the track the viewport takes of the content", () => {
  // Half the content is on screen, so the thumb is half the track.
  expect(thumb({ contentRows: 20, viewportRows: 10, scrollTop: 0, trackRows: 10 })).toEqual({
    start: 0,
    size: 5,
  });
});

test("scrolled to the end, the thumb sits flush against the bottom", () => {
  // Anything else leaves a gap that reads as "there is more below" when
  // there is not.
  expect(thumb({ contentRows: 20, viewportRows: 10, scrollTop: 10, trackRows: 10 })).toEqual({
    start: 5,
    size: 5,
  });
});

test("a very long transcript still leaves a thumb to see", () => {
  // Rounding alone would give this a height of zero, and a scrollbar you
  // cannot see is worse than none at all.
  const long = thumb({ contentRows: 10_000, viewportRows: 10, scrollTop: 0, trackRows: 10 });
  expect(long.size).toBe(1);
});

/**
 * This one went green before the minimum-size clamp existed, and was a false
 * positive when it did.
 *
 * It originally asserted only `start + size === trackRows`. Without the clamp
 * the answer was `start: 10, size: 0` — a thumb of no height parked one row
 * past the end of the track — which sums to 10 and passed, while drawing
 * nothing at all. The sum was true of both the right answer and the worst
 * wrong one.
 *
 * So it asserts the whole shape now. A test that can pass for a reason other
 * than the one it is named for is worse than no test, because it reports
 * safety that was never checked.
 */
test("a one-row thumb at the end still fits inside the track", () => {
  const end = thumb({ contentRows: 10_000, viewportRows: 10, scrollTop: 9_990, trackRows: 10 });
  expect(end).toEqual({ start: 9, size: 1 });
});

test("halfway down, the thumb is halfway down", () => {
  expect(thumb({ contentRows: 30, viewportRows: 10, scrollTop: 10, trackRows: 12 })).toEqual({
    start: 4,
    size: 4,
  });
});
