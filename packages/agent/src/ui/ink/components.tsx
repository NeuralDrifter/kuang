// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The parts that only draw.
 *
 * Kept apart from `app.tsx`, which owns state, input and the wiring to the
 * loop. These take props and return elements, so they can be rendered to a
 * string and asserted on without a terminal — which is the only way the UI
 * gets tested at all, since a TTY is exactly what a test does not have.
 */
// `React` is imported for its own sake, not only for the types below.
// Which JSX transform runs depends on whichever tsconfig the runner finds,
// and that depends on the working directory: tests run from this package and
// get the automatic runtime, while `npx tsx src/main.ts agent` runs from
// packages/cli, finds a config with no jsx setting, and falls back to the
// classic transform — which emits `React.createElement`. Importing React
// makes the file correct under both, rather than under whichever was guessed.
import React from "react";
import { Box, Text, type DOMElement } from "ink";
import type { ApprovalDecision } from "../../core/approvals.ts";
import type { Entry, FileChange, TranscriptState } from "./transcript.ts";
import type { Question } from "./pending.ts";
import { thumb, type ScrollGeometry } from "./scroll.ts";

/** The unscrolled part of the track. */
const TRACK = "░";
/** The visible window, in the pane the paging keys are pointed at. */
const THUMB_FOCUSED = "█";
/** The same window in the other pane. Shape, not colour, so it survives a pipe. */
const THUMB_IDLE = "▒";

/**
 * A pane's scrollbar: one column, a thumb against a dotted track.
 *
 * Takes the measured geometry rather than the entries, so the thumb is a
 * picture of rendered rows and not of how many entries happen to be in the
 * list — those differ whenever a reply wraps.
 */
export function Scrollbar({
  geometry,
  focused = false,
}: {
  geometry: ScrollGeometry;
  /** Whether this pane takes the paging keys, shown so it need not be guessed. */
  focused?: boolean;
}): React.ReactElement {
  const { trackRows } = geometry;
  const { start, size } = thumb(geometry);

  // Decided once rather than per row, and named, because the glyphs are the
  // component's whole meaning: solid says "this pane takes the paging keys".
  const thumbGlyph = focused ? THUMB_FOCUSED : THUMB_IDLE;

  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: trackRows }, (_, row) => {
        const onThumb = row >= start && row < start + size;
        return (
          <Text key={row} dimColor={!onThumb} color={focused && onThumb ? "cyan" : undefined}>
            {onThumb ? thumbGlyph : TRACK}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * One column of the split layout: a clipped viewport over its entries, with
 * its own scrollbar.
 *
 * Both panes were written out longhand and differed only in which entries
 * they held and which side they padded — so a fix to one drifted from the
 * other, and a third panel meant a third copy.
 *
 * `divider` draws the rule between the panes. A boolean prop rather than two
 * components because it is a style switch in Ink's own idiom, alongside
 * `borderTop` and `borderRight`, and it changes nothing about what the
 * component does.
 */
export function Pane({
  contentRef,
  geometry,
  focused,
  divider = false,
  children,
}: {
  contentRef: React.RefObject<DOMElement | null>;
  geometry: ScrollGeometry;
  focused: boolean;
  divider?: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Box width="50%" flexDirection="row">
      <Box
        flexGrow={1}
        flexShrink={1}
        height="100%"
        flexDirection="column"
        borderStyle={divider ? "single" : undefined}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor="gray"
      >
        <Box flexGrow={1} flexDirection="column" overflowY="hidden">
          <Box paddingX={1} flexDirection="column">
            {/*
              flexShrink={0} keeps the content at its natural height so it can
              overflow and be scrolled; without it Yoga squeezes it into the
              viewport and there is nothing left to move. The negative margin is
              the scroll: the parent clips, this slides under the clip.
            */}
            <Box
              ref={contentRef}
              flexDirection="column"
              flexShrink={0}
              marginTop={-geometry.scrollTop}
            >
              {children}
            </Box>
          </Box>
        </Box>
      </Box>
      <Scrollbar geometry={geometry} focused={focused} />
    </Box>
  );
}

/**
 * One file the agent changed: its name, its counts, and the hunks.
 *
 * The diff text already carries its own meaning — `+` added, `-` removed,
 * space context — because colour is lost down a pipe and absent for anyone
 * who cannot distinguish it. Colour only reinforces the markers.
 */
export function FileDiff({ change }: { change: FileChange }): React.ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0} marginY={1}>
      <Text bold>
        {change.path} <Text color="green">+{change.added}</Text>{" "}
        <Text color="red">-{change.removed}</Text>
      </Text>
      {change.diff.split("\n").map((line, i) => {
        const colour =
          line.startsWith("+") && !line.startsWith("+++")
            ? "green"
            : line.startsWith("-") && !line.startsWith("---")
              ? "red"
              : undefined;
        return (
          <Text key={i} color={colour} dimColor={colour === undefined}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * The panel menu, drawn only.
 *
 * Numbered so a digit is a one-key accelerator, and the `❯` marks the row the
 * arrows are on. Selection and key handling live with the state that owns
 * them; this stays a pure function of its props like everything else here.
 */
export function Menu({
  items,
  selected,
}: {
  items: string[];
  selected: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} marginY={1}>
      <Text bold>Panel</Text>
      {items.map((item, i) => (
        <Text key={item} color={i === selected ? "cyan" : undefined}>
          {i === selected ? "❯" : " "} {i + 1} {item}
        </Text>
      ))}
      <Text dimColor>↑↓ move · enter choose · esc cancel</Text>
    </Box>
  );
}

/** What the status line needs, without handing it the whole session. */
export interface StatusInfo {
  id: string;
  model: string;
  redacting: boolean;
}

/** Colour per kind of line, so the eye can sort the conversation at a glance. */
const COLOUR: Record<Entry["kind"], string> = {
  user: "cyan",
  reply: "white",
  tool: "yellow",
  notice: "magenta",
  error: "red",
};

/**
 * A marker per kind of line. No entry for `reply`: the model's own text is
 * the body of the transcript rather than an annotation on it, and `Line`
 * returns before reaching here. Typed to exclude it so it cannot be added
 * back and sit unread.
 */
const MARKER: Record<Exclude<Entry["kind"], "reply">, string> = {
  user: "❯",
  tool: "⚙",
  notice: "💡",
  error: "✖",
};

export function Line({ entry }: { entry: Entry }): React.ReactElement {
  const colour = entry.ok === false ? "red" : COLOUR[entry.kind];
  if (entry.kind === "reply") {
    return (
      <Box marginY={1}>
        <Text color={colour}>{entry.text}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Box width={3} justifyContent="center" alignItems="flex-start">
        <Text color={colour}>{MARKER[entry.kind]}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={colour}>{entry.text}</Text>
      </Box>
    </Box>
  );
}

export function Status({
  state,
  session,
  hint,
}: {
  state: TranscriptState;
  session: StatusInfo;
  /**
   * Keys the current layout actually listens for.
   *
   * Left empty rather than filled with something plausible: this used to
   * advertise "esc to cancel" unconditionally, while escape was only handled
   * inside the approval and passphrase prompts and a turn in flight could not
   * be cancelled at all.
   */
  hint?: string;
}): React.ReactElement {
  const total = state.tokens.prompt + state.tokens.completion;
  return (
    <Box justifyContent="space-between" width="100%">
      {/*
        The hint gives way on a narrow terminal: it truncates instead of
        wrapping, so the status stays one line and a hint tail can never
        break free of its label onto its own row.
      */}
      <Box flexShrink={1}>
        {hint ? (
          <Text dimColor wrap="truncate">
            {hint}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>
          {session.model} · {session.redacting ? "redacting" : "no redaction"} ·{" "}
          {session.id.slice(0, 15)}
          {total > 0 ? ` · ${total} tokens` : ""}
          {state.busy ? " · working" : ""}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The consent prompt, drawn only.
 *
 * The keys that answer it are handled by the component that owns the
 * conversation's state, because answering changes that state — and because
 * keeping this a pure function of its props is what lets it be rendered to a
 * string and asserted on without a terminal.
 */
export function Approval({
  question,
}: {
  question: Question<ApprovalDecision>;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="yellow" bold>
          ⚠️ Approval required
        </Text>
      </Box>
      <Text>{question.prompt}</Text>
      {question.detail ? (
        <Box
          marginTop={1}
          paddingLeft={2}
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor="gray"
        >
          <Text dimColor>{question.detail}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text>
          <Text color="green" bold>
            y
          </Text>
          <Text dimColor>es · </Text>
          <Text color="red" bold>
            n
          </Text>
          <Text dimColor>o · </Text>
          <Text color="yellow" bold>
            a
          </Text>
          <Text dimColor>lways</Text>
        </Text>
      </Box>
    </Box>
  );
}
