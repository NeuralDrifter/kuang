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
import type { CommandContext } from "bailian-cli-core";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import type { AgentEvent } from "../../core/events.ts";
import type { PlatformAccess } from "../../core/platform.ts";
import type { AgentOptions, InkSession } from "../../index.ts";
import {
  emptyTranscript,
  reduce,
  withNotice,
  withUserMessage,
  type Entry,
  type TranscriptState,
} from "./transcript.ts";

/** Colour per kind of line, so the eye can sort the conversation at a glance. */
const COLOUR: Record<Entry["kind"], string> = {
  user: "cyan",
  reply: "white",
  tool: "yellow",
  notice: "magenta",
  error: "red",
};

const MARKER: Record<Entry["kind"], string> = {
  user: "›",
  reply: " ",
  tool: "·",
  notice: "⚠",
  error: "✗",
};

function Line({ entry }: { entry: Entry }): React.ReactElement {
  const colour = entry.ok === false ? "red" : COLOUR[entry.kind];
  return (
    <Box>
      <Text color={colour}>{MARKER[entry.kind]} </Text>
      <Text color={colour}>{entry.text}</Text>
    </Box>
  );
}

function Status({
  state,
  session,
}: {
  state: TranscriptState;
  session: InkSession;
}): React.ReactElement {
  const total = state.tokens.prompt + state.tokens.completion;
  return (
    <Box>
      <Text dimColor>
        {session.model} · {session.redacting ? "redacting" : "no redaction"} ·{" "}
        {session.id.slice(0, 15)}
        {total > 0 ? ` · ${total} tokens` : ""}
        {state.busy ? " · working" : ""}
      </Text>
    </Box>
  );
}

interface AppProps {
  session: InkSession;
  /** Returns the events for one turn, and resolves when the turn is done. */
  onSubmit: (input: string, emit: (event: AgentEvent) => void) => Promise<void>;
  /** Handles a slash command, returning text to show or "exit". */
  onCommand: (input: string) => { text?: string; exit?: boolean } | undefined;
}

function App({ session, onSubmit, onCommand }: AppProps): React.ReactElement {
  const [state, setState] = useState<TranscriptState>(emptyTranscript);
  const [draft, setDraft] = useState("");
  const { exit } = useApp();
  const busy = useRef(false);

  const emit = useCallback((event: AgentEvent) => {
    setState((current) => reduce(current, event));
  }, []);

  const submit = useCallback(
    (text: string) => {
      // A slash command is the user talking to the program, so it runs now
      // whether or not a turn is in flight, and never reaches the model.
      const handled = onCommand(text);
      if (handled) {
        if (handled.text) setState((current) => withNotice(current, handled.text!));
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
    [emit, exit, onCommand, onSubmit],
  );

  useInput((input, key) => {
    if (key.return) {
      const text = draft.trim();
      setDraft("");
      if (text) submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    // Ink hands a paste over as one `input` string, so this appends the whole
    // block rather than a character — which is what keeps paste intact.
    if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
  });

  return (
    <Box flexDirection="column">
      <Static items={state.done}>{(entry) => <Line key={entry.id} entry={entry} />}</Static>

      {state.streaming ? <Text>{state.streaming}</Text> : null}

      <Box marginTop={state.done.length > 0 ? 1 : 0}>
        <Text color="cyan">› </Text>
        <Text>{draft}</Text>
        <Text inverse> </Text>
      </Box>

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

  const app = render(
    <App session={wiring.session} onSubmit={wiring.onSubmit} onCommand={wiring.onCommand} />,
  );
  await app.waitUntilExit();
}
