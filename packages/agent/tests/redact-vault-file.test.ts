// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The sealed vault on disk — the one file in this project that can hold a real
 * secret, and only when asked for.
 */
import { expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WrongPassphraseError } from "../src/core/redact/sealed.ts";
import { forgetVault, hasVault, loadVault, saveVault } from "../src/core/redact/vault-file.ts";
import { Vault } from "../src/core/redact/vault.ts";

const CARD = "4111 1111 1111 1111";
const PASS = "a passphrase";

function path(): string {
  return join(mkdtempSync(join(tmpdir(), "kuang-vf-")), "s1.vault.json");
}

function loaded(): Vault {
  const vault = new Vault();
  vault.sanitize(CARD);
  return vault;
}

test("a saved vault reopens with the right passphrase", () => {
  const p = path();
  const original = loaded();
  saveVault("s1", original, PASS, p);

  const revived = new Vault();
  revived.absorb(loadVault("s1", PASS, p)!);

  const id = original.snapshot().values;
  const placeholder = Object.keys(id)[0]!;
  expect(revived.restore(placeholder)).toBe(CARD);
});

test("the file on disk holds no plaintext secret", () => {
  const p = path();
  saveVault("s1", loaded(), PASS, p);

  // The whole justification for writing it at all.
  expect(readFileSync(p, "utf-8")).not.toContain("4111");
});

test("a wrong passphrase throws rather than returning nothing", () => {
  const p = path();
  saveVault("s1", loaded(), PASS, p);

  // Distinguishable from "no vault here", because the caller should say
  // something different to the user in each case.
  expect(() => loadVault("s1", "wrong", p)).toThrow(WrongPassphraseError);
});

test("no vault is undefined, not an error", () => {
  expect(loadVault("s1", PASS, join(tmpdir(), "kuang-absent-vault-123.json"))).toBeUndefined();
});

test("a file that is not a sealed vault is undefined, not an error", () => {
  const p = path();
  writeFileSync(p, JSON.stringify({ something: "else" }), "utf-8");
  expect(loadVault("s1", PASS, p)).toBeUndefined();
});

test("a damaged file is undefined rather than stopping a resume", () => {
  const p = path();
  writeFileSync(p, "{ not json", "utf-8");
  expect(loadVault("s1", PASS, p)).toBeUndefined();
});

test("hasVault reports whether there is anything to ask about", () => {
  const p = path();
  expect(hasVault("s1", p)).toBe(false);
  saveVault("s1", loaded(), PASS, p);
  expect(hasVault("s1", p)).toBe(true);
});

test("forgetting deletes the file outright", () => {
  const p = path();
  saveVault("s1", loaded(), PASS, p);
  forgetVault("s1", p);

  // Not quarantined like a damaged file: the user has said these should not
  // be on this disk, and leaving a copy aside would defeat that.
  expect(existsSync(p)).toBe(false);
  expect(hasVault("s1", p)).toBe(false);
});

test("forgetting something that is not there is not an error", () => {
  // /pii forget should work whether or not saving was ever on.
  expect(() => forgetVault("s1", join(tmpdir(), "kuang-absent-987.json"))).not.toThrow();
});

test("saving twice replaces rather than appends", () => {
  const p = path();
  saveVault("s1", loaded(), PASS, p);

  const second = new Vault();
  second.sanitize("mike@realdomain.co.uk");
  saveVault("s1", second, PASS, p);

  const snapshot = loadVault("s1", PASS, p)!;
  expect(Object.values(snapshot.values)).toEqual(["mike@realdomain.co.uk"]);
});
