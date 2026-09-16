// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The wired app, driven through a fake terminal.
 *
 * `components.tsx` is tested by rendering pieces that hold no state. This
 * covers what that deliberately cannot: the layout switch, the pane geometry
 * and the key handling, which are the parts where a mistake shows up as a
 * crash or a blank screen rather than as a wrong string.
 */
import React from "react";
import { expect, test } from "vite-plus/test";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { App } from "../src/ui/ink/app.tsx";
import type { InkWiring } from "../src/index.ts";

/**
 * Wiring that does nothing, so the test is about the UI and not the loop.
 *
 * `onCommand` still answers `/panes`, because that is what the real one does:
 * the command lives in `core/slash.ts` and reaches the renderer as an outcome.
 * A stub that swallowed it would let the layout switch break unnoticed.
 */
function wiring(over: Partial<InkWiring> = {}): InkWiring {
  return {
    session: { id: "session-1", model: "a-model", redacting: false } as InkWiring["session"],
    onSubmit: async () => {},
    onCommand: (input) => (input.trim() === "/panes" ? { layout: true } : undefined),
    setApprovalHandler: () => {},
    onMount: async () => {},
    doSaveSecrets: async () => {},
    doForgetSecrets: () => {},
    ...over,
  };
}

/** Render the app against a fake TTY and type `keys` into it. */
async function drive(keys: string, over: Partial<InkWiring> = {}): Promise<string> {
  let out = "";

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const stdout = new Writable({
    write(chunk, _encoding, done) {
      out += String(chunk);
      done();
    },
  }) as Writable & { columns: number; rows: number };
  stdout.columns = 80;
  stdout.rows = 24;

  const element: React.ReactElement = <App {...wiring(over)} />;
  const app = render(element, {
    stdin: stdin as never,
    stdout: stdout as never,
    patchConsole: false,
  });

  // Let the first render and its effects settle, so a prompt raised on mount
  // is listening before anything is typed at it.
  await new Promise((resolve) => setTimeout(resolve, 40));

  // One character at a time. Written as a single chunk, Ink reads the whole
  // string as one input event — which is how it keeps a paste intact, and
  // which would mean the trailing return never arrives as a keypress.
  for (const key of keys) {
    stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 6));
  }

  await new Promise((resolve) => setTimeout(resolve, 120));
  app.unmount();
  return out;
}

const ENTER = "\r";

test("the app starts in the flow layout, with no scrollbars", async () => {
  const screen = await drive("");
  // Asserted positively as well: an absent scrollbar is also what a crashed
  // render looks like, and a test that cannot tell those apart proves nothing.
  expect(screen).toContain("a-model");
  expect(screen).not.toContain("░");
});

test("/panes switches layout and draws a scrollbar for each pane", async () => {
  const screen = await drive(`/panes${ENTER}`);

  // Solid rather than dotted: an empty transcript fits its pane, and a thumb
  // that fills its whole track is how "there is nothing below" is drawn.
  // A dotted run here would mean the geometry thinks content is off-screen
  // when none exists.
  expect(screen).toContain("█");
  expect(screen).not.toContain("░");
});

test("the panes layout says which pane the paging keys will move", async () => {
  const screen = await drive(`/panes${ENTER}`);
  expect(screen).toContain("tab: conversation");
});

test("tab moves focus to the other pane", async () => {
  const screen = await drive(`/panes${ENTER}\t`);
  expect(screen).toContain("tab: tools");
});

test("the mouse starts unhooked, so the terminal keeps its selection", async () => {
  const screen = await drive(`/panes${ENTER}`);
  expect(screen).toContain("mouse off");
});

test("a passphrase is delivered exactly as typed, spaces and all", async () => {
  // The prompt trims what it submits, because a stray space before a command
  // is a slip. A passphrase is not: trimming it silently changes the secret
  // and the user is left with a vault they cannot open.
  let answered: string | undefined = "never asked";

  await drive(`  hunter two  ${ENTER}`, {
    onMount: async (ask) => {
      answered = await ask("Passphrase: ");
    },
  });

  expect(answered).toBe("  hunter two  ");
});
