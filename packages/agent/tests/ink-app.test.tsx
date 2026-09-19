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
  // A realistic width, as a real terminal has; at 80 columns the status line
  // legitimately truncates the hint, which is tested separately in the
  // components suite.
  stdout.columns = 120;
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

test("/panes opens a menu instead of switching, listing the choices", async () => {
  const screen = await drive(`/panes${ENTER}`);

  // The menu is the fourth state of the input block; layout has not moved.
  expect(screen).toContain("1 Tool calls");
  expect(screen).toContain("2 Live diff");
  expect(screen).toContain("3 Back to flow");
  expect(screen).not.toContain("tab: conversation"); // still flow
});

test("escape closes the menu and leaves the layout alone", async () => {
  const screen = await drive(`/panes${ENTER}\x1b`);

  expect(screen).not.toContain("Tool calls");
  expect(screen).not.toContain("tab: conversation"); // still flow
});

test("choosing tool calls enters panes with the tool log", async () => {
  const screen = await drive(`/panes${ENTER}1`);

  expect(screen).toContain("tab: conversation");
  expect(screen).toContain("█"); // scrollbars drawn
  expect(screen).toContain("mouse off");
});

test("choosing live diff enters panes with the diff pane", async () => {
  const screen = await drive(`/panes${ENTER}2`);

  expect(screen).toContain("tab: conversation");
  expect(screen).toContain("mode: diff");
});

test("arrows move the selection, enter chooses", async () => {
  // down once selects "Live diff", enter activates it.
  const screen = await drive(`/panes${ENTER}\x1b[B${ENTER}`);
  expect(screen).toContain("mode: diff");
});

test("from panes, choosing back to flow returns there", async () => {
  const screen = await drive(`/panes${ENTER}1/panes${ENTER}3`);

  expect(screen).not.toContain("tab: conversation"); // flow again
  expect(screen).toContain("a-model"); // status line still there
});

test("tab moves focus to the other pane", async () => {
  const screen = await drive(`/panes${ENTER}1\t`);
  expect(screen).toContain("tab: tools");
});

test("the mouse starts unhooked, so the terminal keeps its selection", async () => {
  const screen = await drive(`/panes${ENTER}1`);
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

test("the diff pane shows what the agent changed", async () => {
  // The stage's whole point: an event the loop emitted appears in the panel.
  const screen = await drive(`hello?\r/panes${ENTER}2`, {
    onSubmit: async (_input, emit) => {
      emit({ type: "turn_start" });
      emit({
        type: "file_changed",
        path: "src/a.ts",
        diff: "--- src/a.ts\n+++ src/a.ts\n+new line",
        added: 1,
        removed: 0,
      });
      emit({ type: "turn_end", usage: { promptTokens: 1, completionTokens: 1 } });
    },
  });

  expect(screen).toContain("mode: diff");
  expect(screen).toContain("src/a.ts");
  expect(screen).toContain("+new line");
});

test("the diff pane shows removals as well as additions", async () => {
  const screen = await drive(`hello?\r/panes${ENTER}2`, {
    onSubmit: async (_input, emit) => {
      emit({ type: "turn_start" });
      emit({
        type: "file_changed",
        path: "src/a.ts",
        diff: "--- src/a.ts\n+++ src/a.ts\n-old line\n+new line",
        added: 1,
        removed: 1,
      });
      emit({ type: "turn_end", usage: { promptTokens: 1, completionTokens: 1 } });
    },
  });

  expect(screen).toContain("mode: diff");
  expect(screen).toContain("-old line");
  expect(screen).toContain("+new line");
});
