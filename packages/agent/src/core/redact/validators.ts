// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Checksum validators for the redaction rules.
 *
 * These exist because shape alone is worthless. The prototype these replace
 * treated any nine digits as a Canadian SIN and any two letters followed by a
 * hex-ish run as an IBAN, so it fired constantly on ordinary source and
 * corrupted every file the agent read. A rule that matches structure and then
 * validates is the difference between a redaction layer and a shredder.
 *
 * Every function here is pure and takes the raw matched text, tolerating the
 * spaces and dashes people actually type.
 */

/** Digits only, discarding the separators humans write. */
function digits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * Luhn mod-10. Used by payment cards and the Canadian SIN.
 *
 * Note `0000000000000000` passes — Luhn proves a number is not a typo, not
 * that it is a real account. The rules pair it with a length and prefix check.
 */
export function luhn(value: string): boolean {
  const d = digits(value);
  if (d.length < 2) return false;

  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ISO 7064 MOD 97-10, as used by IBAN.
 *
 * Move the first four characters to the end, map letters to two-digit numbers
 * (A=10 … Z=35), and the whole thing mod 97 must be 1.
 */
export function iso7064Mod97_10(value: string): boolean {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false;

  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const mapped = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of mapped) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

const CN_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_CHECK = "10X98765432";

/**
 * ISO 7064 MOD 11-2, as used by the Chinese resident identity card.
 * Eighteen characters: seventeen digits and a check character which may be X.
 */
export function iso7064Mod11_2(value: string): boolean {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[0-9]{17}[0-9X]$/.test(s)) return false;

  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CN_WEIGHTS[i] * Number(s[i]);
  return CN_CHECK[(12 - (sum % 11)) % 11] === s[17];
}

const NRIC_WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
/** Checksum letters, indexed by the weighted sum mod 11. */
const NRIC_LETTERS: Record<string, string> = {
  // S/T are citizens and permanent residents; F/G/M are foreign identification.
  S: "JZIHGFEDCBA",
  T: "JZIHGFEDCBA",
  F: "XWUTRQPNMLK",
  G: "XWUTRQPNMLK",
  M: "XWUTRQPNMLK",
};
/** Offsets applied before the lookup for the later prefixes. */
const NRIC_OFFSET: Record<string, number> = { S: 0, F: 0, T: 4, G: 4, M: 3 };

/** Singapore NRIC / FIN weighted checksum. */
export function nricChecksum(value: string): boolean {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[STFGM][0-9]{7}[A-Z]$/.test(s)) return false;

  const prefix = s[0];
  const table = NRIC_LETTERS[prefix];
  if (!table) return false;

  let sum = NRIC_OFFSET[prefix] ?? 0;
  for (let i = 0; i < 7; i++) sum += NRIC_WEIGHTS[i] * Number(s[i + 1]);
  return table[sum % 11] === s[8];
}

/**
 * French NIR control key: the last two digits are 97 minus the rest mod 97.
 * Corsican departments use 2A/2B, which map to 19/18 before the arithmetic.
 */
export function nirKey(value: string): boolean {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[12][0-9]{2}[0-9]{2}(?:[0-9]{2}|2[AB])[0-9]{3}[0-9]{3}[0-9]{2}$/.test(s)) return false;

  const body = s.slice(0, 13).replace("2A", "19").replace("2B", "18");
  const key = Number(s.slice(13));
  return 97 - (Number(body) % 97) === key;
}

/**
 * US SSN structural validity. There is no checksum, so this only excludes the
 * ranges the SSA never issues — which is still enough to reject most incidental
 * nine-digit numbers.
 */
export function ssnStructurallyValid(value: string): boolean {
  const d = digits(value);
  if (d.length !== 9) return false;

  const area = Number(d.slice(0, 3));
  const group = Number(d.slice(3, 5));
  const serial = Number(d.slice(5));
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

/**
 * Shannon entropy in bits per character. Used to tell a generated credential
 * from an ordinary identifier — `getUserByIdentifier` is low-entropy English,
 * a random token is not.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
