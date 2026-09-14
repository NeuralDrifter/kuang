// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { Vault } from "../src/core/redact/vault.ts";

const CARD = "4111 1111 1111 1111";
const CARD2 = "5500 0000 0000 0004";
const EMAIL = "mike@realdomain.co.uk";

test("a sensitive value is replaced with a labelled placeholder", () => {
  const v = new Vault();
  const { text } = v.sanitize(`pay with ${CARD} please`);

  expect(text).not.toContain("4111");
  // The label tells the model what kind of hole it is looking at.
  expect(text).toMatch(/\[REDACTED_CARD_1\]/);
});

test("sanitize then restore returns the original exactly", () => {
  const v = new Vault();
  const original = `card ${CARD}, email ${EMAIL}, done.`;

  expect(v.restore(v.sanitize(original).text)).toBe(original);
});

test("the same value always gets the same placeholder", () => {
  const v = new Vault();
  const { text } = v.sanitize(`${CARD} and again ${CARD}`);

  const ids = [...text.matchAll(/\[REDACTED_CARD_\d+\]/g)].map((m) => m[0]);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test("stable placeholders survive across separate sanitize calls", () => {
  const v = new Vault();
  const first = v.sanitize(`one ${CARD}`).text;
  const second = v.sanitize(`two ${CARD}`).text;

  // The model must be able to refer back to a value it saw in an earlier turn.
  const id = first.match(/\[REDACTED_CARD_\d+\]/)![0];
  expect(second).toContain(id);
});

test("different values of the same kind get different numbers", () => {
  const v = new Vault();
  const { text } = v.sanitize(`${CARD} and ${CARD2}`);

  const ids = new Set([...text.matchAll(/\[REDACTED_CARD_\d+\]/g)].map((m) => m[0]));
  expect(ids.size).toBe(2);
});

test("restore works on text the model rewrote around the placeholder", () => {
  const v = new Vault();
  const id = v.sanitize(CARD).text;

  // The model copies the placeholder into new prose; restoration must still hit.
  expect(v.restore(`The card on file is ${id}.`)).toBe(`The card on file is ${CARD}.`);
});

test("restore is exact against adjacent punctuation", () => {
  const v = new Vault();
  const { text } = v.sanitize(`(${EMAIL}),`);
  expect(v.restore(text)).toBe(`(${EMAIL}),`);
});

test("text with nothing sensitive passes through untouched", () => {
  const v = new Vault();
  const code = "const timeout = 300000; // packages/agent/src/core/loop.ts";
  const { text, found } = v.sanitize(code);

  expect(text).toBe(code);
  expect(found).toEqual({});
});

test("sanitize reports what it replaced, for the user-facing warning", () => {
  const v = new Vault();
  const { found } = v.sanitize(`${CARD} ${CARD2} ${EMAIL}`);

  expect(found).toEqual({ CARD: 2, EMAIL: 1 });
});

test("stats accumulate across the session", () => {
  const v = new Vault();
  v.sanitize(`${CARD}`);
  v.sanitize(`${EMAIL}`);

  expect(v.stats()).toEqual({ total: 2, byRule: { CARD: 1, EMAIL: 1 } });
});

test("a repeated value is counted once in the session total", () => {
  const v = new Vault();
  v.sanitize(`${CARD} ${CARD}`);

  // Two occurrences, one secret. The total counts distinct values held.
  expect(v.stats().total).toBe(1);
});

// ── the toggle ──────────────────────────────────────────────────────────────

test("a disabled vault leaves text alone", () => {
  const v = new Vault(false);
  const { text, found } = v.sanitize(`pay with ${CARD}`);

  expect(text).toBe(`pay with ${CARD}`);
  expect(found).toEqual({});
});

test("disabling still restores values captured while it was on", () => {
  const v = new Vault();
  const id = v.sanitize(CARD).text;
  v.setEnabled(false);

  // Turning it off must not strand placeholders the model already has.
  expect(v.restore(`see ${id}`)).toBe(`see ${CARD}`);
});

test("the toggle reports its own state", () => {
  const v = new Vault();
  expect(v.enabled).toBe(true);
  v.setEnabled(false);
  expect(v.enabled).toBe(false);
});

// ── restoration safety ──────────────────────────────────────────────────────

test("an unknown placeholder is left as written rather than blanked", () => {
  const v = new Vault();
  // The model can hallucinate a placeholder that was never issued.
  expect(v.restore("value [REDACTED_CARD_99] here")).toBe("value [REDACTED_CARD_99] here");
});

test("restore does not rewrite text that merely looks like a placeholder", () => {
  const v = new Vault();
  expect(v.restore("see [REDACTED] or [redacted_card_1]")).toBe(
    "see [REDACTED] or [redacted_card_1]",
  );
});
