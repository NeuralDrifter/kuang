// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findMatches } from "../src/core/redact/rules.ts";

function ids(text: string): string[] {
  return findMatches(text).map((m) => m.ruleId);
}

// ── the regression that matters ─────────────────────────────────────────────

/** Every `.ts` file under the given package sources. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (entry.isFile() && abs.endsWith(".ts")) out.push(abs);
  }
  return out;
}

test("no rule fires on this repository's own source", () => {
  // This is the test the previous implementation failed. Its rules matched
  // ordinary code — hex digests, nine-digit numbers, two-letters-plus-digits —
  // and it ran over tool results, so every file the agent read came back
  // corrupted and it never knew.
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const files = [
    ...sourceFiles(join(root, "agent", "src")),
    ...sourceFiles(join(root, "core", "src")),
    ...sourceFiles(join(root, "runtime", "src")),
  ];
  expect(files.length).toBeGreaterThan(30);

  const offenders: string[] = [];
  for (const file of files) {
    // The rules file states example patterns in prose; exclude it alone.
    if (file.endsWith(join("redact", "rules.ts"))) continue;
    for (const m of findMatches(readFileSync(file, "utf-8"))) {
      offenders.push(`${file.slice(root.length + 1)} — ${m.ruleId}: ${m.value.slice(0, 40)}`);
    }
  }

  expect(offenders).toEqual([]);
});

test("common code shapes are not mistaken for identifiers", () => {
  const code = [
    "const hash = 'ab12cdef0123456789abcdef';",
    "const id = 123456789;",
    "const ts = 1726234567890;",
    "const sha = 'de00000000000000000000';",
    "const version = '1.24.0';",
    "const port = 8080, timeout = 300000;",
    "const uuid = '550e8400-e29b-41d4-a716-446655440000';",
    "const ref = 'AB123456';",
    "const color = '#1a2b3c';",
    "const path = 'packages/agent/src/core/redact/rules.ts';",
  ].join("\n");

  expect(findMatches(code)).toEqual([]);
});

// ── each rule actually fires on a real value ────────────────────────────────

test("a valid card is caught, an invalid one is not", () => {
  expect(ids("pay with 4111 1111 1111 1111 today")).toEqual(["CARD"]);
  // One digit off: no longer passes Luhn, so it is left alone.
  expect(ids("pay with 4111 1111 1111 1112 today")).toEqual([]);
});

test("a valid IBAN is caught, a hex digest is not", () => {
  expect(ids("account GB82 WEST 1234 5698 7654 32 please")).toEqual(["IBAN"]);
  expect(ids("digest ab12cdef0123456789abcdef")).toEqual([]);
});

test("an SSN is caught only in its written form", () => {
  expect(ids("ssn 123-45-6789")).toEqual(["US_SSN"]);
  // A bare nine-digit run is a timestamp far more often than an SSN.
  expect(ids("value 123456789")).toEqual([]);
  expect(ids("ssn 000-45-6789")).toEqual([]);
});

test("a Canadian SIN needs separators and a valid checksum", () => {
  expect(ids("sin 046 454 286")).toEqual(["CA_SIN"]);
  expect(ids("sin 046 454 287")).toEqual([]);
});

test("credential prefixes are caught", () => {
  expect(ids("key sk-aB3xK9mQ7zR2vT5wY8nL4pJ6hG1dF0sA here")).toEqual(["TOKEN"]);
  expect(ids("aws AKIAIOSFODNN7EXAMPLE here")).toEqual(["TOKEN"]);
});

test("a private key block is caught whole", () => {
  const block =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  const matches = findMatches(`before\n${block}\nafter`);

  expect(matches.map((m) => m.ruleId)).toEqual(["PRIVATE_KEY"]);
  // The body must not survive as a separate fragment.
  expect(matches[0].value).toContain("MIIEowIBAAKCAQEA");
});

test("an email is caught but a documentation address is not", () => {
  expect(ids("write to mike@realdomain.co.uk")).toEqual(["EMAIL"]);
  expect(ids("write to someone@example.com")).toEqual([]);
});

test("a phone number needs separators", () => {
  expect(ids("call 415-555-0142 now")).toEqual(["NANP_PHONE"]);
  expect(ids("id 4155550142")).toEqual([]);
});

// ── overlap resolution ──────────────────────────────────────────────────────

test("overlapping matches keep the longest", () => {
  // The card is 16 digits; a shorter rule must not claim part of it.
  const matches = findMatches("4111111111111111");
  expect(matches).toHaveLength(1);
  expect(matches[0].ruleId).toBe("CARD");
  expect(matches[0].value).toBe("4111111111111111");
});

test("matches are returned in document order", () => {
  const matches = findMatches("a@realdomain.com then 4111 1111 1111 1111");
  expect(matches.map((m) => m.ruleId)).toEqual(["EMAIL", "CARD"]);
  expect(matches[0].start).toBeLessThan(matches[1].start);
});
