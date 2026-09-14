// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import {
  iso7064Mod11_2,
  iso7064Mod97_10,
  luhn,
  nirKey,
  nricChecksum,
  shannonEntropy,
  ssnStructurallyValid,
} from "../src/core/redact/validators.ts";

/** Flip one digit, so a test proves the checksum discriminates. */
function mutate(value: string): string {
  const i = value.search(/\d/);
  const d = Number(value[i]);
  return value.slice(0, i) + ((d + 1) % 10) + value.slice(i + 1);
}

// ── Luhn ────────────────────────────────────────────────────────────────────

test("luhn accepts a known-valid card number and rejects a mutation", () => {
  // The canonical Visa test number.
  expect(luhn("4111111111111111")).toBe(true);
  expect(luhn(mutate("4111111111111111"))).toBe(false);
});

test("luhn tolerates spaces and dashes", () => {
  expect(luhn("4111 1111 1111 1111")).toBe(true);
  expect(luhn("4111-1111-1111-1111")).toBe(true);
});

test("luhn rejects an obviously fake run of digits", () => {
  // The kind of thing a naive length-only rule would have called a card.
  expect(luhn("1234567890123456")).toBe(false);
  expect(luhn("0000000000000000")).toBe(true); // all zeros does pass Luhn
});

// ── ISO 7064 MOD 97-10 (IBAN) ───────────────────────────────────────────────

test("iban accepts the canonical example and rejects a mutation", () => {
  // The example from the ISO 13616 / Wikipedia reference.
  expect(iso7064Mod97_10("GB82WEST12345698765432")).toBe(true);
  expect(iso7064Mod97_10(mutate("GB82WEST12345698765432"))).toBe(false);
});

test("iban tolerates the spaced print format", () => {
  expect(iso7064Mod97_10("GB82 WEST 1234 5698 7654 32")).toBe(true);
});

test("iban rejects a hex digest, which the old rule matched", () => {
  // `[A-Za-z]{2}\d{2}[A-Za-z0-9]{4,30}` ate things like this.
  expect(iso7064Mod97_10("ab12cdef0123456789abcdef")).toBe(false);
  expect(iso7064Mod97_10("de00000000000000000000")).toBe(false);
});

// ── ISO 7064 MOD 11-2 (Chinese resident ID) ─────────────────────────────────

test("chinese id checksum round-trips and discriminates", () => {
  // Built by computing the check character for a structurally valid body,
  // then asserting a mutated body no longer validates.
  const body = "11010519491231002";
  const check = "10X98765432"[
    (12 -
      ([7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2].reduce(
        (sum, w, i) => sum + w * Number(body[i]),
        0,
      ) %
        11)) %
      11
  ];
  expect(iso7064Mod11_2(body + check)).toBe(true);
  expect(iso7064Mod11_2(mutate(body) + check)).toBe(false);
});

test("chinese id rejects a plain run of eighteen digits", () => {
  expect(iso7064Mod11_2("123456789012345678")).toBe(false);
});

// ── Singapore NRIC / FIN ────────────────────────────────────────────────────

test("nric checksum discriminates", () => {
  // Compute the correct letter, then assert a wrong one fails.
  const digits = "0000001";
  const weights = [2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((a, w, i) => a + w * Number(digits[i]), 0);
  const letter = "JZIHGFEDCBA"[sum % 11];

  expect(nricChecksum("S" + digits + letter)).toBe(true);
  expect(nricChecksum("S" + digits + (letter === "A" ? "B" : "A"))).toBe(false);
});

// ── French NIR ──────────────────────────────────────────────────────────────

test("nir key discriminates", () => {
  // 13 digits: sex, year, month, department, commune, order. Then a 2-digit key.
  const body = "1801294380012";
  const key = String(97 - (Number(body) % 97)).padStart(2, "0");

  expect(nirKey(body + key)).toBe(true);
  expect(nirKey(body + (key === "01" ? "02" : "01"))).toBe(false);
});

// ── US SSN ──────────────────────────────────────────────────────────────────

test("ssn rejects the reserved and impossible ranges", () => {
  expect(ssnStructurallyValid("123-45-6789")).toBe(true);

  expect(ssnStructurallyValid("000-45-6789")).toBe(false); // area 000
  expect(ssnStructurallyValid("666-45-6789")).toBe(false); // area 666
  expect(ssnStructurallyValid("900-45-6789")).toBe(false); // area 900+
  expect(ssnStructurallyValid("123-00-6789")).toBe(false); // group 00
  expect(ssnStructurallyValid("123-45-0000")).toBe(false); // serial 0000
});

// ── entropy ─────────────────────────────────────────────────────────────────

test("entropy separates a real token from an English word", () => {
  const token = "sk-aB3xK9mQ7zR2vT5wY8nL4pJ6hG1dF0sA";
  expect(shannonEntropy(token)).toBeGreaterThan(3.5);
  // Ordinary identifiers must stay well below the threshold.
  expect(shannonEntropy("getUserByIdentifier")).toBeLessThan(3.9);
  expect(shannonEntropy("aaaaaaaaaaaaaaaaaaaa")).toBeLessThan(1);
});
