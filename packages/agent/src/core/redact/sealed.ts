// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The vault, sealed with a passphrase, for the one case where it has to
 * outlive the process.
 *
 * **Nothing here runs unless the user opts in.** The default is what it has
 * always been: the vault lives in memory, dies with the session, and no secret
 * is written anywhere. This exists so that `--resume` can offer full fidelity
 * to someone who asks for it, not so that it can become normal.
 *
 * The key is derived from a passphrase and never stored. That is the whole
 * design: a key kept beside its ciphertext is decoration, since anything able
 * to read one can read the other, and the OS keychains that would avoid the
 * prompt need a native module — the most common way a globally installed CLI
 * fails to install at all.
 *
 * scrypt for derivation because it is memory-hard, so a stolen file cannot be
 * attacked with a GPU nearly as cheaply as with PBKDF2. AES-256-GCM for
 * sealing because it authenticates: a file edited by anyone who could not
 * decrypt it fails the tag rather than decrypting to plausible nonsense.
 *
 * Both primitives come from `node:crypto`. No dependency is added for this.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { VaultSnapshot } from "./vault.ts";

/** Bumped if the parameters below change, so old files stay readable or are refused. */
const VERSION = 1;

/**
 * scrypt cost. N=2^16 with r=8 takes roughly a tenth of a second and 64 MB —
 * unnoticeable once per resume, and expensive enough per guess to matter if
 * the file is ever taken. `maxmem` must be raised to allow it; the default
 * 32 MB would reject these parameters outright.
 */
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface SealedVault {
  version: number;
  /** Base64. New for every seal, so the same passphrase never repeats a key. */
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("The passphrase does not match this file.");
    this.name = "WrongPassphraseError";
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_BYTES, SCRYPT);
}

/** Encrypt a snapshot under `passphrase`. */
export function seal(snapshot: VaultSnapshot, passphrase: string): SealedVault {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);

  const plaintext = Buffer.from(JSON.stringify(snapshot), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    version: VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Whether `value` is shaped like something `unseal` could attempt. */
export function isSealed(value: unknown): value is SealedVault {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SealedVault>;
  return (
    v.version === VERSION &&
    typeof v.salt === "string" &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.ciphertext === "string"
  );
}

/**
 * Decrypt, or throw `WrongPassphraseError`.
 *
 * A wrong passphrase and a tampered file are deliberately the same error. The
 * distinction is not one the caller can act on, and reporting "the passphrase
 * was right but the file was altered" would confirm a guess to anyone probing.
 */
export function unseal(sealed: SealedVault, passphrase: string): VaultSnapshot {
  const salt = Buffer.from(sealed.salt, "base64");
  const iv = Buffer.from(sealed.iv, "base64");
  const tag = Buffer.from(sealed.tag, "base64");

  // GCM rejects a wrong-length tag with a different error than a wrong one;
  // normalise so a malformed file cannot be told apart from a bad passphrase.
  if (tag.length !== 16) throw new WrongPassphraseError();

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new WrongPassphraseError();
  }

  try {
    const parsed = JSON.parse(plaintext.toString("utf-8")) as Partial<VaultSnapshot>;
    if (typeof parsed?.values !== "object" || parsed.values === null) {
      throw new WrongPassphraseError();
    }
    return { values: parsed.values, counters: parsed.counters ?? {} };
  } catch {
    // The tag already proved the passphrase; anything wrong past this point is
    // a file this build cannot read.
    throw new WrongPassphraseError();
  }
}

/** Constant-time comparison, for callers verifying a passphrase twice over. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
