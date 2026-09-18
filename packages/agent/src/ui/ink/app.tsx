// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ink UI.
 *
 * Reached only when both stdout and stdin are real terminals — Ink draws by
 * redrawing and reads in raw mode, and neither works down a pipe. The plain
 * path in `../../index.ts` stays the fallback, and stays untouched.
 *
 * Nothing under `core/` knows this exists. The turn loop, slash commands,
 * sessions and redaction all speak `AgentEvent` and plain strings, which is
 * what makes a second renderer possible at all rather than a rewrite.
 */
// `React` is imported for its own sake, not only for the types below.
// Which JSX transform runs depends on whichever tsconfig the runner finds,
// and that depends on the working directory: tests run from this package and
// get the automatic runtime, while `npx tsx src/main.ts agent` runs from
// packages/cli, finds a config with no jsx setting, and falls back to the
// classic transform — which emits `React.createElement`. Importing React
// makes the file correct under both, rather than under whichever was guessed.
import React from "react";
import type { CommandContext } from "bailian-cli-core";
import { Box, render, Static, Text, useApp, useBoxMetrics, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../../core/events.ts";
import type { PlatformAccess } from "../../core/platform.ts";
import type { ApprovalDecision } from "../../core/approvals.ts";
import type { AgentOptions, InkWiring } from "../../index.ts";
import type { Question } from "./pending.ts";
import { Approval, Line, Pane as PaneView, Status } from "./components.tsx";
import { MOUSE_OFF, MOUSE_ON, paneForColumn, parseMouseEvents, wheelDelta } from "./mouse.ts";
import {
  clampScroll,
  maxScroll,
  scrollTopForTrackRow,
  type Pane,
  type ScrollGeometry,
} from "./scroll.ts";
import { useLineEditor } from "./use-line-editor.ts";
import {
  emptyTranscript,
  reduce,
  withNotice,
  withUserMessage,
  type TranscriptState,
} from "./transcript.ts";

/**
 * A scroll position larger than any transcript.
 *
 * Clamping turns it into "the last screenful" on every render, so a pane that
 * has not been scrolled follows new output down while one that has been
 * scrolled up stays where it was put.
 */
const AT_BOTTOM = Number.MAX_SAFE_INTEGER;

/**
 * The screen row the panes start on, counted from 1 as mouse reports are.
 *
 * The root box fills the terminal in this layout, so they start at the very
 * top. Named rather than buried in a `- 1`, because it is an assumption about
 * what is drawn above the panes, and if a header ever appears this is the one
 * number that has to change. A bare subtraction would not have said so, and a
 * drag would quietly have landed a row out.
 */
const PANES_TOP_ROW = 1;

export function App({
  session,
  onSubmit,
  onCommand,
  setApprovalHandler,
  onMount,
  doSaveSecrets,
  doForgetSecrets,
}: InkWiring): React.ReactElement {
  const [state, setState] = useState<TranscriptState>(emptyTranscript);
  const line = useLineEditor();
  const [pending, setPending] = useState<Question<ApprovalDecision> | undefined>();
  const [pendingPassphrase, setPendingPassphrase] = useState<
    Question<string | undefined> | undefined
  >();
  const { exit } = useApp();
  const busy = useRef(false);

  // Registered once: the loop raises a question, the component draws it.
  useEffect(() => {
    setApprovalHandler((question) => setPending(question));
  }, [setApprovalHandler]);

  const askPassphrase = useCallback(async (prompt: string): Promise<string | undefined> => {
    let deliver: ((value: string | undefined) => void) | undefined;
    const answered = new Promise<string | undefined>((resolve) => {
      deliver = resolve;
    });
    setPendingPassphrase({
      prompt,
      answer: (value) => {
        if (!deliver) return;
        const resolve = deliver;
        deliver = undefined;
        resolve(value);
        setPendingPassphrase(undefined);
      },
    });
    return answered;
  }, []);

  useEffect(() => {
    void onMount(askPassphrase, (text) => setState((current) => withNotice(current, text)));
  }, [onMount, askPassphrase]);

  const answer = useCallback((decision: ApprovalDecision) => {
    setPending((question) => {
      question?.answer(decision);
      return undefined;
    });
  }, []);

  const emit = useCallback((event: AgentEvent) => {
    setState((current) => reduce(current, event));
  }, []);

  const [layout, setLayout] = useState<"flow" | "panes">("flow");

  const submit = useCallback(
    (text: string) => {
      // A slash command is the user talking to the program, so it runs now
      // whether or not a turn is in flight, and never reaches the model.
      //
      // `/panes` goes through here like everything else rather than being
      // caught above. Intercepting it meant `handleSlash` never saw it, so
      // `/help` — the one place a user looks — could not list it.
      const handled = onCommand(text);
      if (handled) {
        if (handled.text) setState((current) => withNotice(current, handled.text!));
        if (handled.layout) {
          // Both derived from `layout` rather than setting one inside the
          // other's updater: an updater has to be a pure function of the state
          // it is given, and React is free to call it more than once or to
          // discard the result.
          const next = layout === "flow" ? "panes" : "flow";
          setLayout(next);
          setState((current) => withNotice(current, `Switched to ${next} layout.`));
        }
        if (handled.secrets === "save") {
          void doSaveSecrets(askPassphrase, (msg) => setState((c) => withNotice(c, msg)));
        } else if (handled.secrets === "forget") {
          doForgetSecrets((msg) => setState((c) => withNotice(c, msg)));
        }
        if (handled.exit) exit();
        return;
      }
      if (busy.current) return;

      busy.current = true;
      setState((current) => withUserMessage(current, text));
      void onSubmit(text, emit).finally(() => {
        busy.current = false;
      });
    },
    [emit, exit, onCommand, onSubmit, doSaveSecrets, doForgetSecrets, askPassphrase, layout],
  );

  // While a question is up, every keystroke means an answer to it, so the
  // ordinary typing handler below stands down.
  useInput(
    (input, key) => {
      const choice = input.toLowerCase();
      if (choice === "y") answer("allow");
      else if (choice === "a") answer("allow_always");
      // Escape and ctrl-c both mean no, which is the safe reading of each.
      else if (choice === "n" || key.escape || (key.ctrl && choice === "c")) answer("deny");
    },
    { isActive: pending !== undefined },
  );

  useInput(
    (input, key) => {
      // A hooked mouse reports through the same channel as the keyboard, so
      // its escape sequences arrive here looking like typing. They are not,
      // and letting them reach the draft fills the prompt with `[<64;25;10M`.
      if (mouseHooked && parseMouseEvents(input).length > 0) return;

      if (key.return) {
        // Trimmed here and not in `take`: the prompt forgives a stray space,
        // the passphrase field must not.
        const text = line.take().trim();
        if (text) {
          line.remember(text);
          submit(text);
        }
        return;
      }
      if (key.upArrow) {
        line.older();
        return;
      }
      if (key.downArrow) {
        line.newer();
        return;
      }
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      line.edit(input, key);
    },
    { isActive: pending === undefined && pendingPassphrase === undefined },
  );

  useInput(
    (input, key) => {
      if (key.return) {
        pendingPassphrase?.answer(line.take());
        return;
      }
      if (key.escape || (key.ctrl && input === "c")) {
        line.take();
        pendingPassphrase?.answer(undefined);
        return;
      }
      line.edit(input, key);
    },
    { isActive: pendingPassphrase !== undefined },
  );

  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [columns, setColumns] = useState(stdout.columns || 80);

  useEffect(() => {
    const onResize = () => {
      setRows(stdout.rows);
      setColumns(stdout.columns);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Each pane scrolls on its own: they hold different amounts, so one shared
  // offset moved them by different fractions and they drifted apart.
  const [scroll, setScroll] = useState<Record<Pane, number>>({
    conversation: AT_BOTTOM,
    tools: AT_BOTTOM,
  });
  const [focused, setFocused] = useState<Pane>("conversation");
  const [mouseHooked, setMouseHooked] = useState(false);
  const [dragging, setDragging] = useState<Pane | undefined>();

  const viewportRef = useRef(null);
  const convRef = useRef(null);
  const toolRef = useRef(null);
  const viewportBox = useBoxMetrics(viewportRef);
  const convBox = useBoxMetrics(convRef);
  const toolBox = useBoxMetrics(toolRef);

  const conversation = state.done.filter((e) => e.kind !== "tool");
  const tools = state.done.filter((e) => e.kind === "tool");

  const viewportRows = Math.max(1, viewportBox.height);
  const contentRows: Record<Pane, number> = {
    conversation: convBox.height,
    tools: toolBox.height,
  };

  // Clamped here rather than where it is set: the maximum shrinks when the
  // terminal grows, and a position from before would point past the end.
  const scrollTop: Record<Pane, number> = {
    conversation: clampScroll(scroll.conversation, contentRows.conversation, viewportRows),
    tools: clampScroll(scroll.tools, contentRows.tools, viewportRows),
  };

  /** Everything a pane needs to draw and place its scrollbar. */
  const geometryFor = (pane: Pane): ScrollGeometry => ({
    contentRows: contentRows[pane],
    viewportRows,
    scrollTop: scrollTop[pane],
    trackRows: viewportRows,
  });

  /**
   * Put one pane at `next`, or back on the bottom when that is where it
   * lands, so a pane the user has not scrolled keeps following new output.
   */
  function moveTo(pane: Pane, next: number): void {
    const bottom = maxScroll(contentRows[pane], viewportRows);
    setScroll((current) => ({ ...current, [pane]: next >= bottom ? AT_BOTTOM : next }));
  }

  function scrollBy(pane: Pane, delta: number): void {
    moveTo(pane, clampScroll(scrollTop[pane] + delta, contentRows[pane], viewportRows));
  }

  /** Follow a grab on the scrollbar, `trackRow` counted from the track's top. */
  function scrollToTrackRow(pane: Pane, trackRow: number): void {
    moveTo(pane, scrollTopForTrackRow(trackRow, viewportRows, contentRows[pane], viewportRows));
  }

  // The split is the last column of the left pane; each pane's scrollbar is
  // its own last column. Derived rather than measured, because useBoxMetrics
  // reports positions relative to a parent and mouse reports are absolute.
  const splitColumn = Math.floor(columns / 2);
  const scrollbarPaneAt = (column: number): Pane | undefined => {
    if (column === splitColumn) return "conversation";
    if (column === columns) return "tools";
    return undefined;
  };

  const panesLive = layout === "panes" && pending === undefined && pendingPassphrase === undefined;

  useEffect(() => {
    if (!mouseHooked || layout !== "panes") return;
    stdout.write(MOUSE_ON);
    const release = () => stdout.write(MOUSE_OFF);
    // React's cleanup covers unmount and toggle. The exit hooks cover the ways
    // a process ends without unmounting — otherwise the terminal keeps
    // reporting into whatever the user runs next.
    process.on("exit", release);
    return () => {
      release();
      process.off("exit", release);
    };
  }, [mouseHooked, layout, stdout]);

  useInput(
    (input, key) => {
      if (key.tab) {
        setFocused((pane) => (pane === "conversation" ? "tools" : "conversation"));
        return;
      }
      if (key.ctrl && input === "o") {
        setMouseHooked((on) => !on);
        return;
      }
      // A screenful less one row, so a line stays on screen to read against.
      const page = Math.max(1, viewportRows - 1);
      if (key.pageUp) scrollBy(focused, -page);
      if (key.pageDown) scrollBy(focused, page);
    },
    { isActive: panesLive },
  );

  useInput(
    (input) => {
      for (const event of parseMouseEvents(input)) {
        const delta = wheelDelta(event.button);
        if (delta !== undefined) {
          scrollBy(paneForColumn(event.column, splitColumn), delta);
          continue;
        }
        if (!event.pressed) {
          setDragging(undefined);
          continue;
        }
        // Once a drag starts the pointer owns that scrollbar, even when it
        // wanders off the column.
        const pane = dragging ?? scrollbarPaneAt(event.column);
        if (!pane) continue;
        setDragging(pane);
        scrollToTrackRow(pane, event.row - PANES_TOP_ROW);
      }
    },
    { isActive: mouseHooked && panesLive },
  );

  const inputBlock = (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
      width="100%"
    >
      {pending ? (
        <Approval question={pending} />
      ) : pendingPassphrase ? (
        <Box>
          <Text color="yellow" bold>
            {pendingPassphrase.prompt}
          </Text>
          <Text color="cyan"> {">"} </Text>
          <Text>
            {"*".repeat(line.cursor)}
            <Text inverse>{line.cursor < line.text.length ? "*" : " "}</Text>
            {"*".repeat(Math.max(0, line.text.length - line.cursor - 1))}
          </Text>
        </Box>
      ) : (
        <Box>
          <Box width={2}>
            <Text color="cyan">{">"}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text>
              {line.text.slice(0, line.cursor)}
              <Text inverse>{line.text[line.cursor] || " "}</Text>
              {line.text.slice(line.cursor + 1)}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );

  if (layout === "flow") {
    return (
      <Box flexDirection="column">
        <Static items={state.done}>{(entry) => <Line key={entry.id} entry={entry} />}</Static>

        {state.streaming ? <Text>⡇ {state.streaming}</Text> : null}

        {inputBlock}

        <Status state={state} session={session} />
      </Box>
    );
  }

  return (
    // One row shorter AND one column narrower than the terminal. Measured from
    // a real run: Ink pads every pane row with trailing spaces to the box's
    // full width, so a box the exact size of the terminal writes 46 full-width
    // rows per frame. Each one lands in the last column, sets pending-wrap,
    // and its newline scrolls the terminal — ~47 scrolls per redraw, every
    // keystroke and every token. The content always sits at the top of the
    // frame, so it was always just scrolled out of view while the bottom rows
    // of older frames (scrollbars, borders) stayed visible and stable. That
    // is also where the alternating blank rows between scrollbar glyphs came
    // from: one scroll inserted between consecutive glyph rows. `rows - 1`
    // alone was never enough — the full-width rows keep scrolling; both
    // dimensions have to step back.
    <Box height={Math.max(1, rows - 1)} width={Math.max(1, columns - 1)} flexDirection="column">
      <Box ref={viewportRef} flexGrow={1} flexDirection="row">
        <PaneView
          contentRef={convRef}
          entries={conversation}
          geometry={geometryFor("conversation")}
          focused={focused === "conversation"}
        >
          {state.streaming ? (
            <Box flexShrink={0} marginTop={1}>
              <Text>⡇ {state.streaming}</Text>
            </Box>
          ) : null}
        </PaneView>

        <PaneView
          contentRef={toolRef}
          entries={tools}
          geometry={geometryFor("tools")}
          focused={focused === "tools"}
          divider
        />
      </Box>

      {inputBlock}

      <Status
        state={state}
        session={session}
        hint={`tab: ${focused} · ctrl+o: mouse ${mouseHooked ? "on" : "off"}`}
      />
    </Box>
  );
}

export async function runInkAgent(
  ctx: CommandContext,
  cwd: string,
  platform: PlatformAccess | undefined,
  options: AgentOptions,
): Promise<void> {
  const { buildInkSession } = await import("../../index.ts");
  const wiring = await buildInkSession(ctx, cwd, platform, options);

  const app = render(<App {...wiring} />);
  await app.waitUntilExit();
}
