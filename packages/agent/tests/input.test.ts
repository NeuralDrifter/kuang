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
  const next = createMessageReader(src, COALESCE);

  src.emit("line", "hello");
  expect(await next()).toBe("hello");
});

test("a line that arrives before anyone asks is not lost", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

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
  const next = createMessageReader(src, COALESCE);

  // A pasted stack trace. Twenty separate turns would be twenty billed
  // requests for what the user meant as one message.
  src.emit("line", "Error: boom");
  src.emit("line", "  at foo (a.ts:1:1)");
  src.emit("line", "  at bar (b.ts:2:2)");

  expect(await next()).toBe("Error: boom\n  at foo (a.ts:1:1)\n  at bar (b.ts:2:2)");
});

test("lines typed with a pause between them stay separate messages", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

  src.emit("line", "what is 2 + 2");
  await settle();
  src.emit("line", "and 3 + 3");

  expect(await next()).toBe("what is 2 + 2");
  expect(await next()).toBe("and 3 + 3");
});

test("a message pending when input ends is still delivered", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

  // A piped file whose last line has no trailing newline still ends with
  // close; discarding the buffer there would drop real input.
  src.emit("line", "last thing");
  src.emit("close");

  expect(await next()).toBe("last thing");
});

test("after input ends and the queue drains, the reader reports EOF", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

  src.emit("line", "only");
  src.emit("close");

  expect(await next()).toBe("only");
  expect(await next()).toBeUndefined();
});

test("a reader already waiting is released by close", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

  // Ctrl+D at an empty prompt must not hang the REPL.
  const pending = next();
  src.emit("close");
  expect(await pending).toBeUndefined();
});

test("a waiting reader receives the next message as it arrives", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

  const pending = next();
  src.emit("line", "typed after asking");
  expect(await pending).toBe("typed after asking");
});

test("an empty line is a message, not a dropped one", async () => {
  const src = source();
  const next = createMessageReader(src, COALESCE);

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
  const next = createMessageReader(src, COALESCE);

  // Everything a pipe holds is delivered in one tick, so it reads as one
  // message rather than a queue of prompts.
  for (const line of ["line one", "line two", "line three"]) src.emit("line", line);
  src.emit("close");

  expect(await next()).toBe("line one\nline two\nline three");
  expect(await next()).toBeUndefined();
});
