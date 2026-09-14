// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { StreamRestorer } from "../src/core/redact/stream.ts";
import { Vault } from "../src/core/redact/vault.ts";

const CARD = "4111 1111 1111 1111";

/** A vault holding one card, plus the placeholder it issued. */
function loaded(): { vault: Vault; id: string } {
  const vault = new Vault();
  const id = vault.sanitize(CARD).text;
  return { vault, id };
}

/** Feed `text` through in fixed-size chunks and collect everything emitted. */
function stream(vault: Vault, text: string, size: number): string {
  const r = new StreamRestorer(vault);
  let out = "";
  for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
  return out + r.flush();
}

test("a placeholder arriving whole is restored", () => {
  const { vault, id } = loaded();
  expect(stream(vault, `card ${id} ok`, 100)).toBe(`card ${CARD} ok`);
});

test("a placeholder split at every possible boundary still restores", () => {
  const { vault, id } = loaded();
  const text = `card ${id} ok`;

  // This is the whole point of the buffering: a chunk boundary must never
  // cause a raw `[REDACTED_...` to reach the screen.
  for (let split = 1; split < text.length; split++) {
    const r = new StreamRestorer(vault);
    const out = r.push(text.slice(0, split)) + r.push(text.slice(split)) + r.flush();
    expect(out, `split at ${split}`).toBe(`card ${CARD} ok`);
  }
});

test("one character at a time still restores", () => {
  const { vault, id } = loaded();
  expect(stream(vault, `card ${id} ok`, 1)).toBe(`card ${CARD} ok`);
});

test("no partial placeholder is ever emitted mid-stream", () => {
  const { vault, id } = loaded();
  const text = `card ${id} ok`;
  const r = new StreamRestorer(vault);

  const pieces: string[] = [];
  for (const ch of text) pieces.push(r.push(ch));
  pieces.push(r.flush());

  // Nothing emitted may contain a fragment of the placeholder syntax.
  for (const piece of pieces) {
    expect(piece).not.toMatch(/\[REDACTED/);
    expect(piece).not.toMatch(/^\[R?E?D?A?C?T?E?D?_?$/);
  }
  expect(pieces.join("")).toBe(`card ${CARD} ok`);
});

test("ordinary text flows through without being held back", () => {
  const vault = new Vault();
  const r = new StreamRestorer(vault);

  // Text with no `[` must be emitted immediately, not buffered until flush.
  expect(r.push("hello ")).toBe("hello ");
  expect(r.push("world")).toBe("world");
});

test("a bracket that is not a placeholder is released, not held forever", () => {
  const vault = new Vault();
  const r = new StreamRestorer(vault);

  const emitted = r.push("see [note] here") + r.flush();
  expect(emitted).toBe("see [note] here");
});

test("an unterminated bracket run is eventually released rather than buffered without limit", () => {
  const vault = new Vault();
  const r = new StreamRestorer(vault);

  // A model can emit `[REDACTED_` and then talk about something else forever.
  // Holding that in memory unbounded would be a leak and would swallow output.
  let out = r.push("[REDACTED_");
  out += r.push("A".repeat(200));
  out += r.flush();

  expect(out).toContain("[REDACTED_");
  expect(out).toContain("A".repeat(200));
});

test("flush empties the buffer so the restorer can be reused", () => {
  const { vault, id } = loaded();
  const r = new StreamRestorer(vault);

  // A complete placeholder is restored and emitted by push itself; flush only
  // releases what was still being held.
  const first = r.push(`first ${id}`) + r.flush();
  const second = r.push("second") + r.flush();

  expect(first).toBe(`first ${CARD}`);
  expect(second).toBe("second");
});

test("multiple placeholders in one stream all restore", () => {
  const vault = new Vault();
  const a = vault.sanitize("4111 1111 1111 1111").text;
  const b = vault.sanitize("mike@realdomain.co.uk").text;

  expect(stream(vault, `${a} and ${b}`, 3)).toBe("4111 1111 1111 1111 and mike@realdomain.co.uk");
});
