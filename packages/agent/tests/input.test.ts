// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The input reader. The property that matters is that nothing is ever lost:
 * a line that arrives while no one is asking for it must still be delivered.
 */
import { EventEmitter } from "node:events";
import { expect, test } from "vite-plus/test";
import { createMessageReader } from "../src/core/input.ts";

const COALESCE = 10;

function source(): EventEmitter {
  return new EventEmitter();
}

/** Let the coalesce window close. */
function settle(ms = COALESCE * 3): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("a single line is delivered as one message", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  src.emit("line", "hello");
  expect(await next()).toBe("hello");
});

test("a line that arrives before anyone asks is not lost", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  // This is the whole bug: readline dropped these.
  src.emit("line", "first");
  await settle();
  src.emit("line", "second");
  await settle();

  expect(await next()).toBe("first");
  expect(await next()).toBe("second");
});

test("lines arriving together become one message, not several turns", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  // A pasted stack trace. Twenty separate turns would be twenty billed
  // requests for what the user meant as one message.
  src.emit("line", "Error: boom");
  src.emit("line", "  at foo (a.ts:1:1)");
  src.emit("line", "  at bar (b.ts:2:2)");

  expect(await next()).toBe("Error: boom\n  at foo (a.ts:1:1)\n  at bar (b.ts:2:2)");
});

test("lines typed with a pause between them stay separate messages", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  src.emit("line", "what is 2 + 2");
  await settle();
  src.emit("line", "and 3 + 3");

  expect(await next()).toBe("what is 2 + 2");
  expect(await next()).toBe("and 3 + 3");
});

test("a message pending when input ends is still delivered", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  // A piped file whose last line has no trailing newline still ends with
  // close; discarding the buffer there would drop real input.
  src.emit("line", "last thing");
  src.emit("close");

  expect(await next()).toBe("last thing");
});

test("after input ends and the queue drains, the reader reports EOF", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  src.emit("line", "only");
  src.emit("close");

  expect(await next()).toBe("only");
  expect(await next()).toBeUndefined();
});

test("a reader already waiting is released by close", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  // Ctrl+D at an empty prompt must not hang the REPL.
  const pending = next();
  src.emit("close");
  expect(await pending).toBeUndefined();
});

test("a waiting reader receives the next message as it arrives", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  const pending = next();
  src.emit("line", "typed after asking");
  expect(await pending).toBe("typed after asking");
});

test("an empty line is a message, not a dropped one", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  src.emit("line", "");
  await settle();
  src.emit("line", "after");

  // The REPL decides what to do with a blank line; the reader must not
  // silently swallow it and hand over the following one instead.
  expect(await next()).toBe("");
  expect(await next()).toBe("after");
});

test("a whole piped script arrives as one message", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE });

  // Everything a pipe holds is delivered in one tick, so it reads as one
  // message rather than a queue of prompts.
  for (const line of ["line one", "line two", "line three"]) src.emit("line", line);
  src.emit("close");

  expect(await next()).toBe("line one\nline two\nline three");
  expect(await next()).toBeUndefined();
});

// ── intercepting ────────────────────────────────────────────────────────────
//
// A slash command is the user talking to the program, not to the model. It
// should run the moment it is typed, whatever the model is doing, and it
// should never reach the model at all.

test("an intercepted message never reaches the queue", async () => {
  const src = source();
  const seen: string[] = [];
  const next = createMessageReader(src, {
    coalesceMs: COALESCE,
    intercept: (message) => {
      if (!message.startsWith("/")) return false;
      seen.push(message);
      return true;
    },
  });

  src.emit("line", "/pii off");
  await settle();
  src.emit("line", "a real question");

  expect(seen).toEqual(["/pii off"]);
  // The command is gone from the stream entirely; only the prompt remains.
  expect(await next()).toBe("a real question");
});

test("interception happens without anyone waiting to read", async () => {
  const src = source();
  const seen: string[] = [];
  createMessageReader(src, {
    coalesceMs: COALESCE,
    intercept: (message) => {
      seen.push(message);
      return true;
    },
  });

  // Nothing is reading — the model has the floor. It must still run.
  src.emit("line", "/pii off");
  await settle();
  expect(seen).toEqual(["/pii off"]);
});

test("a message the interceptor declines is queued as normal", async () => {
  const src = source();
  const next = createMessageReader(src, { coalesceMs: COALESCE, intercept: () => false });

  src.emit("line", "ordinary");
  expect(await next()).toBe("ordinary");
});

test("a pasted block is offered whole, not line by line", async () => {
  const src = source();
  const offered: string[] = [];
  createMessageReader(src, {
    coalesceMs: COALESCE,
    intercept: (message) => {
      offered.push(message);
      return true;
    },
  });

  // Otherwise a diff containing a line starting with / would be mistaken for
  // a command halfway through a paste.
  src.emit("line", "/usr/bin/env");
  src.emit("line", "second line");
  await settle();

  expect(offered).toEqual(["/usr/bin/env\nsecond line"]);
});
