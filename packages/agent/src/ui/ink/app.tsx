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

function App({ session, onSubmit, onCommand, setApprovalHandler }: InkWiring): React.ReactElement {
  const [state, setState] = useState<TranscriptState>(emptyTranscript);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Question<ApprovalDecision> | undefined>();
  const { exit } = useApp();
  const busy = useRef(false);

  // Registered once: the loop raises a question, the component draws it.
  useEffect(() => {
    setApprovalHandler((question) => setPending(question));
  }, [setApprovalHandler]);

  const answer = useCallback((decision: ApprovalDecision) => {
    setPending((question) => {
      question?.answer(decision);
      return undefined;
    });
  }, []);

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
    },
    { isActive: pending === undefined },
  );

  return (
    <Box flexDirection="column">
      <Static items={state.done}>{(entry) => <Line key={entry.id} entry={entry} />}</Static>

      {state.streaming ? <Text>{state.streaming}</Text> : null}

      {pending ? (
        <Approval question={pending} />
      ) : (
        <Box marginTop={state.done.length > 0 ? 1 : 0}>
          <Text color="cyan">› </Text>
          <Text>{draft}</Text>
          <Text inverse> </Text>
        </Box>
      )}

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
