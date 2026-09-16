// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Which pane something belongs to.
 *
 * Lives here rather than with the mouse: how the screen is divided is a
 * layout question, and the mouse is only one of the three things that asks.
 */
export type Pane = "conversation" | "tools";

/**
 * The furthest the content can be scrolled — content that does not overflow
 * cannot scroll at all.
 *
 * The one place this is worked out. It used to be recomputed at five sites
 * across two modules, and one of them had already drifted by dropping the
 * lower bound and leaning on a caller's early return to stay correct.
 */
export function maxScroll(contentRows: number, viewportRows: number): number {
  return Math.max(0, contentRows - viewportRows);
}

/**
 * Hold a scroll position inside what there is to scroll.
 *
 * Applied on every render rather than only where the keys are handled: the
 * maximum shrinks when the terminal grows or the content is replaced, and a
 * position left over from before would otherwise point past the end.
 */
export function clampScroll(scrollTop: number, contentRows: number, viewportRows: number): number {
  return Math.min(maxScroll(contentRows, viewportRows), Math.max(0, scrollTop));
}

/**
 * Where a grab on the track puts the content — the inverse of `thumb`.
 *
 * The last row maps to the very end rather than to one step short of it, so
 * dragging the thumb to the bottom of the track actually reaches the bottom
 * of the transcript.
 */
export function scrollTopForTrackRow(
  trackRow: number,
  trackRows: number,
  contentRows: number,
  viewportRows: number,
): number {
  if (trackRows <= 1) return 0;
  const fraction = Math.min(1, Math.max(0, trackRow / (trackRows - 1)));
  return Math.round(maxScroll(contentRows, viewportRows) * fraction);
}

/**
 * Everything needed to place a viewport inside its content, and a thumb
 * inside its track.
 *
 * One record rather than four positional numbers: `scrollTopForTrackRow` and
 * `Scrollbar` both took several same-typed arguments in a row, where a
 * transposition would have type-checked and scrolled the wrong distance.
 */
export interface ScrollGeometry {
  contentRows: number;
  viewportRows: number;
  scrollTop: number;
  trackRows: number;
}

export interface Thumb {
  start: number;
  size: number;
}

export function thumb({ contentRows, viewportRows, scrollTop, trackRows }: ScrollGeometry): Thumb {
  const furthest = maxScroll(contentRows, viewportRows);
  if (furthest === 0) return { start: 0, size: trackRows };

  // At least one row: a transcript long enough to round the thumb away would
  // otherwise leave a scrollbar with nothing in it.
  const size = Math.max(1, Math.round(trackRows * (viewportRows / contentRows)));

  // The thumb travels the track minus its own length, so a full scroll puts
  // its bottom edge on the track's bottom edge rather than its top edge.
  const travel = trackRows - size;
  const fraction = Math.min(1, Math.max(0, scrollTop / furthest));

  return { start: Math.round(travel * fraction), size };
}
