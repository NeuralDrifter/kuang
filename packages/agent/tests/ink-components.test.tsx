// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The UI, rendered and read back.
 *
 * A test has no terminal, which is exactly why the drawing parts were kept
 * free of state and input: Ink will render to any writable stream, so what
 * reaches the screen can be asserted on rather than assumed.
 */
// `React` is imported for its own sake, not only for the types below.
// Which JSX transform runs depends on whichever tsconfig the runner finds,
// and that depends on the working directory: tests run from this package and
// get the automatic runtime, while `npx tsx src/main.ts agent` runs from
// packages/cli, finds a config with no jsx setting, and falls back to the
// classic transform — which emits `React.createElement`. Importing React
// makes the file correct under both, rather than under whichever was guessed.
import React from "react";
import { expect, test } from "vite-plus/test";
import { render } from "ink";
import { Writable } from "node:stream";
import { Approval, Line, Status } from "../src/ui/ink/components.tsx";
import { ask } from "../src/ui/ink/pending.ts";
import { emptyTranscript, type Entry } from "../src/ui/ink/transcript.ts";
import type { ApprovalDecision } from "../src/core/approvals.ts";

/** Render to a string, the way the terminal would have seen it. */
async function draw(element: React.ReactElement): Promise<string> {
  let out = "";
  const sink = new Writable({
    write(chunk, _encoding, done) {
      out += String(chunk);
      done();
    },
  }) as never;

  const app = render(element, { stdout: sink, patchConsole: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.unmount();
  return out;
}

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 1,
  kind: "reply",
  text: "hello",
  ...over,
});

test("a line reaches the screen with its text", async () => {
  expect(await draw(<Line entry={entry({ text: "the model said this" })} />)).toContain(
    "the model said this",
  );
});

test("each kind of line is marked differently", async () => {
  const user = await draw(<Line entry={entry({ kind: "user", text: "a" })} />);
  const tool = await draw(<Line entry={entry({ kind: "tool", text: "a" })} />);
  const error = await draw(<Line entry={entry({ kind: "error", text: "a" })} />);

  // The eye should sort the conversation without reading it.
  expect(new Set([user.trim()[0], tool.trim()[0], error.trim()[0]]).size).toBe(3);
});

test("an approval shows what is being asked and how to answer", async () => {
  const { question } = ask<ApprovalDecision>("shell: rm -rf build (in /proj)");
  const screen = await draw(<Approval question={question} />);

  expect(screen).toContain("Approval required");
  expect(screen).toContain("rm -rf build");
  // Every option has to be visible, or the prompt is a guess.
  expect(screen).toContain("es");
  expect(screen).toContain("lways");
});

test("an approval shows the diff when there is one", async () => {
  const { question } = ask<ApprovalDecision>("write_file(a.ts)", "--- a.ts\n+++ a.ts\n+added");
  const screen = await draw(<Approval question={question} />);

  // Approving a write without seeing it is the thing the whole gate exists
  // to prevent.
  expect(screen).toContain("+added");
});

test("an approval without a diff does not leave an empty gap", async () => {
  const { question } = ask<ApprovalDecision>("read_file(a.ts)");
  const screen = await draw(<Approval question={question} />);
  expect(screen).not.toContain("undefined");
});

test("the status line carries what /pii and /sessions would have to be asked", async () => {
  const screen = await draw(
    <Status
      state={emptyTranscript()}
      session={{ id: "20260915T185055-abc", model: "qwen-max", redacting: true }}
    />,
  );

  expect(screen).toContain("qwen-max");
  expect(screen).toContain("redacting");
  expect(screen).toContain("20260915T185055");
});

test("the status line says when redaction is off", async () => {
  const screen = await draw(
    <Status
      state={emptyTranscript()}
      session={{ id: "s1", model: "qwen-max", redacting: false }}
    />,
  );
  // Ambiguity here is the dangerous direction.
  expect(screen).toContain("no redaction");
});

test("tokens appear only once some have been spent", async () => {
  const quiet = await draw(
    <Status state={emptyTranscript()} session={{ id: "s1", model: "m", redacting: false }} />,
  );
  expect(quiet).not.toContain("tokens");

  const spent = await draw(
    <Status
      state={{ ...emptyTranscript(), tokens: { prompt: 100, completion: 20 } }}
      session={{ id: "s1", model: "m", redacting: false }}
    />,
  );
  expect(spent).toContain("120 tokens");
});

test("a turn in flight says so", async () => {
  const screen = await draw(
    <Status
      state={{ ...emptyTranscript(), busy: true }}
      session={{ id: "s1", model: "m", redacting: false }}
    />,
  );
  expect(screen).toContain("working");
});
