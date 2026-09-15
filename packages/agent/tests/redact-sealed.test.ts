// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The sealed vault. This is the only place in the project where a real secret
 * is written to disk at all, and only when the user asks for it, so the tests
 * are about the properties that make that defensible rather than about the
 * round trip.
 */
import { expect, test } from "vite-plus/test";
import {
  isSealed,
  sameSecret,
  seal,
  unseal,
  WrongPassphraseError,
  type SealedVault,
} from "../src/core/redact/sealed.ts";
import { Vault, type VaultSnapshot } from "../src/core/redact/vault.ts";

const CARD = "4111 1111 1111 1111";
const PASS = "correct horse battery staple";

function snapshot(): VaultSnapshot {
  return {
    values: { "[REDACTED_CARD_1]": CARD, "[REDACTED_EMAIL_1]": "mike@realdomain.co.uk" },
    counters: { CARD: 1, EMAIL: 1 },
  };
}

test("a sealed vault round-trips", () => {
  expect(unseal(seal(snapshot(), PASS), PASS)).toEqual(snapshot());
});

test("the ciphertext contains no plaintext secret", () => {
  const sealed = seal(snapshot(), PASS);

  // The whole point. Assert on the serialised form, since that is the file.
  const serialised = JSON.stringify(sealed);
  expect(serialised).not.toContain("4111");
  expect(serialised).not.toContain("realdomain");
  expect(serialised).not.toContain("REDACTED_CARD_1");
});

test("the passphrase is not stored anywhere in the file", () => {
  expect(JSON.stringify(seal(snapshot(), PASS))).not.toContain("correct horse");
});

test("a wrong passphrase is refused rather than decrypting to nonsense", () => {
  const sealed = seal(snapshot(), PASS);
  expect(() => unseal(sealed, "wrong")).toThrow(WrongPassphraseError);
});

test("a passphrase differing by one character is refused", () => {
  const sealed = seal(snapshot(), PASS);
  expect(() => unseal(sealed, PASS + "!")).toThrow(WrongPassphraseError);
});

test("tampering with the ciphertext is detected", () => {
  const sealed = seal(snapshot(), PASS);
  const bytes = Buffer.from(sealed.ciphertext, "base64");
  bytes[0] ^= 0xff;

  // GCM authenticates: an edit by someone who could not decrypt must fail,
  // not silently change what comes back out.
  const tampered: SealedVault = { ...sealed, ciphertext: bytes.toString("base64") };
  expect(() => unseal(tampered, PASS)).toThrow(WrongPassphraseError);
});

test("tampering with the tag is detected", () => {
  const sealed = seal(snapshot(), PASS);
  const tag = Buffer.from(sealed.tag, "base64");
  tag[0] ^= 0xff;
  expect(() => unseal({ ...sealed, tag: tag.toString("base64") }, PASS)).toThrow(
    WrongPassphraseError,
  );
});

test("a truncated tag fails the same way as a wrong passphrase", () => {
  const sealed = seal(snapshot(), PASS);
  // A malformed file must not be distinguishable from a bad guess.
  expect(() => unseal({ ...sealed, tag: "YWJj" }, PASS)).toThrow(WrongPassphraseError);
});

test("swapping the salt is detected", () => {
  const a = seal(snapshot(), PASS);
  const b = seal(snapshot(), PASS);
  expect(() => unseal({ ...a, salt: b.salt }, PASS)).toThrow(WrongPassphraseError);
});

test("sealing the same data twice produces different bytes", () => {
  const a = seal(snapshot(), PASS);
  const b = seal(snapshot(), PASS);

  // Fresh salt and iv each time: identical files would leak that nothing
  // changed between two saves.
  expect(a.salt).not.toBe(b.salt);
  expect(a.iv).not.toBe(b.iv);
  expect(a.ciphertext).not.toBe(b.ciphertext);
});

test("an empty vault seals and unseals", () => {
  const empty: VaultSnapshot = { values: {}, counters: {} };
  expect(unseal(seal(empty, PASS), PASS)).toEqual(empty);
});

test("a unicode passphrase works and is normalised", () => {
  const sealed = seal(snapshot(), "café 密码");
  expect(unseal(sealed, "café 密码")).toEqual(snapshot());
});

test("isSealed recognises its own output and rejects anything else", () => {
  expect(isSealed(seal(snapshot(), PASS))).toBe(true);
  for (const junk of [null, undefined, 42, "x", {}, { version: 99 }]) {
    expect(isSealed(junk), JSON.stringify(junk)).toBe(false);
  }
});

// ── back into a live vault ──────────────────────────────────────────────────

test("an unsealed snapshot restores placeholders in a new vault", () => {
  const original = new Vault();
  const id = original.sanitize(CARD).text;

  const revived = new Vault();
  revived.absorb(unseal(seal(original.snapshot(), PASS), PASS));

  // The point of saving it at all: a placeholder from before the restart
  // still resolves.
  expect(revived.restore(`your card is ${id}`)).toBe(`your card is ${CARD}`);
});

test("absorbing never reissues a number already used", () => {
  const old = new Vault();
  old.sanitize(CARD);

  const fresh = new Vault();
  fresh.absorb(old.snapshot());
  const next = fresh.sanitize("5500 0000 0000 0004").text;

  // Reusing _1 would make two different values share a placeholder, and the
  // wrong one would be restored.
  expect(next).toContain("[REDACTED_CARD_2]");
});

test("a value captured this session wins over a restored one", () => {
  const fresh = new Vault();
  const id = fresh.sanitize(CARD).text;

  fresh.absorb({ values: { [id]: "a stale value" }, counters: {} });
  expect(fresh.restore(id)).toBe(CARD);
});

test("comparing two passphrases does not leak length by throwing", () => {
  expect(sameSecret("abc", "abc")).toBe(true);
  expect(sameSecret("abc", "abd")).toBe(false);
  expect(sameSecret("abc", "abcd")).toBe(false);
});
