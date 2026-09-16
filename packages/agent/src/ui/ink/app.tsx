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
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../../core/events.ts";
import type { PlatformAccess } from "../../core/platform.ts";
import type { ApprovalDecision } from "../../core/approvals.ts";
import type { AgentOptions, InkWiring } from "../../index.ts";
import type { Question } from "./pending.ts";
import { Approval, Line, Status } from "./components.tsx";
import {
  emptyTranscript,
  reduce,
  withNotice,
  withUserMessage,
  type TranscriptState,
} from "./transcript.ts";

function App({
  session,
  onSubmit,
  onCommand,
  setApprovalHandler,
  onMount,
  doSaveSecrets,
  doForgetSecrets,
}: InkWiring): React.ReactElement {
  const [state, setState] = useState<TranscriptState>(emptyTranscript);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyDraft, setHistoryDraft] = useState("");
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
      const trimmed = text.trim();
      if (trimmed === "/panes") {
        setLayout((l) => (l === "flow" ? "panes" : "flow"));
        setState((current) =>
          withNotice(current, `Switched to ${layout === "flow" ? "panes" : "flow"} layout.`),
        );
        return;
      }

      // A slash command is the user talking to the program, so it runs now
      // whether or not a turn is in flight, and never reaches the model.
      const handled = onCommand(text);
      if (handled) {
        if (handled.text) setState((current) => withNotice(current, handled.text!));
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
      if (key.return) {
        const text = draft.trim();
        setDraft("");
        setCursor(0);
        if (text) {
          setHistory((h) => {
            const next = [...h, text];
            setHistoryIndex(next.length);
            return next;
          });
          setHistoryDraft("");
          submit(text);
        }
        return;
      }
      if (key.upArrow) {
        if (history.length > 0 && historyIndex > 0) {
          if (historyIndex === history.length) setHistoryDraft(draft);
          const nextIndex = historyIndex - 1;
          setHistoryIndex(nextIndex);
          setDraft(history[nextIndex]);
          setCursor(history[nextIndex].length);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIndex < history.length) {
          const nextIndex = historyIndex + 1;
          setHistoryIndex(nextIndex);
          if (nextIndex === history.length) {
            setDraft(historyDraft);
            setCursor(historyDraft.length);
          } else {
            setDraft(history[nextIndex]);
            setCursor(history[nextIndex].length);
          }
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(draft.length, c + 1));
        return;
      }
      if (key.backspace) {
        if (cursor > 0) {
          setDraft((d) => d.slice(0, cursor - 1) + d.slice(cursor));
          setCursor((c) => c - 1);
        }
        return;
      }
      if (key.delete) {
        if (cursor < draft.length) {
          setDraft((d) => d.slice(0, cursor) + d.slice(cursor + 1));
        }
        return;
      }
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      // Ink hands a paste over as one `input` string, so this appends the whole
      // block rather than a character — which is what keeps paste intact.
      if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d.slice(0, cursor) + input + d.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: pending === undefined && pendingPassphrase === undefined },
  );

  useInput(
    (input, key) => {
      if (key.return) {
        pendingPassphrase?.answer(draft);
        setDraft("");
        setCursor(0);
        return;
      }
      if (key.escape || (key.ctrl && input === "c")) {
        pendingPassphrase?.answer(undefined);
        setDraft("");
        setCursor(0);
        return;
      }
      if (key.backspace) {
        if (cursor > 0) {
          setDraft((d) => d.slice(0, cursor - 1) + d.slice(cursor));
          setCursor((c) => c - 1);
        }
        return;
      }
      if (key.delete) {
        if (cursor < draft.length) {
          setDraft((d) => d.slice(0, cursor) + d.slice(cursor + 1));
        }
        return;
      }
      if (key.leftArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) setCursor((c) => Math.min(draft.length, c + 1));

      if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d.slice(0, cursor) + input + d.slice(cursor));
        setCursor((c) => c + input.length);
      }
    },
    { isActive: pendingPassphrase !== undefined },
  );

  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const onResize = () => setRows(stdout.rows);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useInput(
    (input, key) => {
      if (key.pageUp) setScrollOffset((o) => o + 5);
      if (key.pageDown) setScrollOffset((o) => Math.max(0, o - 5));
    },
    { isActive: layout === "panes" && pending === undefined && pendingPassphrase === undefined },
  );

  const conversation = state.done.filter((e) => e.kind !== "tool");
  const tools = state.done.filter((e) => e.kind === "tool");

  const visibleConv = conversation.slice(0, conversation.length - scrollOffset);
  const visibleTools = tools.slice(0, tools.length - scrollOffset);

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
            {"*".repeat(cursor)}
            <Text inverse>{cursor < draft.length ? "*" : " "}</Text>
            {"*".repeat(Math.max(0, draft.length - cursor - 1))}
          </Text>
        </Box>
      ) : (
        <Box>
          <Box width={2}>
            <Text color="cyan">{">"}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text>
              {draft.slice(0, cursor)}
              <Text inverse>{draft[cursor] || " "}</Text>
              {draft.slice(cursor + 1)}
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
    <Box height={rows} flexDirection="column" width="100%">
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        <Box
          width="50%"
          flexDirection="column"
          justifyContent="flex-end"
          borderStyle="single"
          borderLeft={false}
          borderTop={false}
          borderBottom={false}
          paddingRight={1}
        >
          {visibleConv.map((entry) => (
            <Box key={entry.id} flexShrink={0} flexDirection="column">
              <Line entry={entry} />
            </Box>
          ))}
          {state.streaming && scrollOffset === 0 ? (
            <Box flexShrink={0} marginTop={1}>
              <Text>⡇ {state.streaming}</Text>
            </Box>
          ) : null}
        </Box>

        <Box width="50%" flexDirection="column" justifyContent="flex-end" paddingLeft={1}>
          {visibleTools.map((entry) => (
            <Box key={entry.id} flexShrink={0} flexDirection="column">
              <Line entry={entry} />
            </Box>
          ))}
        </Box>
      </Box>

      {inputBlock}

      <Status state={state} session={session} />
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
