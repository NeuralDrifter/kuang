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
import { Box, Text } from "ink";
import type { ApprovalDecision } from "../../core/approvals.ts";
import type { Entry, TranscriptState } from "./transcript.ts";
import type { Question } from "./pending.ts";

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

const MARKER: Record<Entry["kind"], string> = {
  user: "❯",
  reply: " ",
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
}: {
  state: TranscriptState;
  session: StatusInfo;
}): React.ReactElement {
  const total = state.tokens.prompt + state.tokens.completion;
  return (
    <Box justifyContent="space-between" width="100%">
      <Box>
        <Text dimColor>esc to cancel</Text>
      </Box>
      <Box>
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
