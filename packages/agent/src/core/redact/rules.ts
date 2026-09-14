// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * What counts as sensitive, and how to be sure.
 *
 * Each rule matches a structure and then validates it. The version this
 * replaces matched structure alone, so "any nine digits" was a Canadian SIN and
 * "two letters then a hex run" was an IBAN — it fired on ordinary source
 * constantly and corrupted every file the agent read.
 *
 * Two deliberate trade-offs, both in favour of precision:
 *
 * - **Separators are required** where an identifier has no checksum strong
 *   enough to stand alone. A bare run of nine digits is usually an arbitrary
 *   identifier — a database id, an order number, a test fixture. The SSN
 *   structural rules only exclude area 000/666/900+, group 00 and serial 0000,
 *   perhaps 10-15% of the space, so matching bare digits would be wrong far
 *   more often than right. Luhn alone passes one nine-digit number in ten.
 *   `123-45-6789` is a claim about what the number is; `123456789` is not.
 * - **Canadian passport is gone.** Two letters and six digits describes a
 *   passport, a prefixed short SHA, and a thousand identifiers. No checksum
 *   exists to separate them.
 */
import type { LocalizedText } from "bailian-cli-core";
import {
  iso7064Mod11_2,
  iso7064Mod97_10,
  luhn,
  nirKey,
  nricChecksum,
  shannonEntropy,
  ssnStructurallyValid,
} from "./validators.ts";

export interface RedactionRule {
  /** Stable id, used in the placeholder: `[REDACTED_CARD_1]`. */
  id: string;
  /**
   * What this rule covers, for `/pii`. It lives on the rule so the coverage
   * the user is shown is the coverage that actually runs — a second list kept
   * elsewhere would drift the first time a rule is added.
   */
  label: LocalizedText;
  /** Global regex. Must not use sticky or the scan misbehaves. */
  pattern: RegExp;
  /** Final say. A match without a passing validator is left alone. */
  validate?: (match: string) => boolean;
}

/** Digits only. */
const d = (s: string) => s.replace(/\D/g, "");

/** Country code to IBAN total length, for the lengths worth pinning. */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
};

/** Minimum bits per character before a token looks generated rather than written. */
const TOKEN_ENTROPY_FLOOR = 3.0;

export const RULES: RedactionRule[] = [
  {
    // Whole armoured block, so the key body never reaches the model.
    id: "PRIVATE_KEY",
    label: { "en-US": "Private keys", "zh-CN": "私钥" },
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    // Known credential prefixes. The prefix does the work; entropy rejects
    // placeholders like `sk-xxxxxxxxxxxxxxxx` that appear in documentation.
    id: "TOKEN",
    label: { "en-US": "API tokens and keys", "zh-CN": "API 令牌与密钥" },
    pattern:
      /\b(?:sk-[A-Za-z0-9_.-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,})/g,
    validate: (m) => shannonEntropy(m) >= TOKEN_ENTROPY_FLOOR,
  },
  {
    id: "CARD",
    label: { "en-US": "Payment card numbers", "zh-CN": "银行卡号" },
    // 13–19 digits, optionally grouped. Anchored so it cannot sit inside a
    // longer run of digits.
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    validate: (m) => {
      const digits = d(m);
      if (digits.length < 13 || digits.length > 19) return false;
      // A run of one repeated digit passes Luhn about a tenth of the time and
      // is never a real card — it is a mask, a placeholder, or test data.
      if (new Set(digits).size === 1) return false;
      return luhn(digits);
    },
  },
  {
    id: "IBAN",
    label: { "en-US": "IBAN bank accounts", "zh-CN": "IBAN 银行账号" },
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{0,4}\b/g,
    validate: (m) => {
      const s = m.replace(/\s/g, "").toUpperCase();
      const expected = IBAN_LENGTH[s.slice(0, 2)];
      if (expected !== undefined && s.length !== expected) return false;
      return iso7064Mod97_10(s);
    },
  },
  {
    id: "CN_ID",
    label: { "en-US": "Chinese resident ID numbers", "zh-CN": "中国居民身份证号" },
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    validate: (m) => {
      if (!iso7064Mod11_2(m)) return false;
      // Birth date must be real; the checksum alone passes 1 in 11.
      const year = Number(m.slice(6, 10));
      const month = Number(m.slice(10, 12));
      const day = Number(m.slice(12, 14));
      return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
    },
  },
  {
    id: "FR_NIR",
    label: { "en-US": "French social security numbers", "zh-CN": "法国社会保障号" },
    pattern: /(?<!\d)[12]\d{2}(?:0[1-9]|1[0-2])(?:\d{2}|2[AB])\d{6}\d{2}(?!\d)/g,
    validate: nirKey,
  },
  {
    id: "SG_NRIC",
    label: { "en-US": "Singapore NRIC and FIN numbers", "zh-CN": "新加坡身份证号" },
    pattern: /\b[STFGMstfgm]\d{7}[A-Za-z]\b/g,
    validate: nricChecksum,
  },
  {
    // Separators required. The structural rules reject only about a tenth of
    // the nine-digit space, so on an arbitrary id they would be wrong far more
    // often than right.
    id: "US_SSN",
    label: { "en-US": "US Social Security numbers", "zh-CN": "美国社会安全号" },
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: ssnStructurallyValid,
  },
  {
    // Separators required, and Luhn. Luhn alone passes one nine-digit number
    // in ten, so without the separator this was the worst rule in the old set.
    id: "CA_SIN",
    label: { "en-US": "Canadian Social Insurance numbers", "zh-CN": "加拿大社会保险号" },
    pattern: /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g,
    validate: (m) => luhn(d(m)),
  },
  {
    // The prefix charset already excludes D, F, I, Q, U, V and the reserved
    // combinations; the suffix is A–D.
    id: "UK_NINO",
    label: { "en-US": "UK National Insurance numbers", "zh-CN": "英国国民保险号" },
    pattern: /\b[ABCEGHJ-PRSTW-Z][ABCEGHJ-NPRSTW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
    validate: (m) => {
      const s = m.replace(/\s/g, "").toUpperCase();
      return !["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"].includes(s.slice(0, 2));
    },
  },
  {
    id: "EU_VAT",
    label: { "en-US": "EU VAT registration numbers", "zh-CN": "欧盟增值税号" },
    pattern:
      /\b(?:ATU\d{8}|BE0\d{9}|BG\d{9,10}|CY\d{8}[A-Z]|CZ\d{8,10}|DE\d{9}|DK\d{8}|EE\d{9}|EL\d{9}|ES[A-Z0-9]\d{7}[A-Z0-9]|FI\d{8}|FR[A-Z0-9]{2}\d{9}|HR\d{11}|HU\d{8}|IE\d[A-Z0-9]\d{5}[A-Z]|IT\d{11}|LT(?:\d{9}|\d{12})|LU\d{8}|LV\d{11}|MT\d{8}|NL\d{9}B\d{2}|PL\d{10}|PT\d{9}|RO\d{2,10}|SE\d{12}|SI\d{8}|SK\d{10})\b/g,
  },
  {
    // No checksum exists, so the boundaries do the work: not adjacent to any
    // other digit, and not part of a longer identifier.
    id: "CN_MOBILE",
    label: { "en-US": "Chinese mobile numbers", "zh-CN": "中国手机号" },
    pattern: /(?<![\d-])1[3-9]\d{9}(?![\d-])/g,
  },
  {
    // Separators required, and a valid NANP area and exchange code.
    id: "NANP_PHONE",
    label: { "en-US": "US and Canadian phone numbers", "zh-CN": "美加电话号码" },
    pattern: /(?<![\d-])(?:\+?1[ -])?\(?[2-9]\d{2}\)?[ -][2-9]\d{2}[ -]\d{4}(?![\d-])/g,
  },
  {
    id: "EMAIL",
    label: { "en-US": "Email addresses", "zh-CN": "电子邮件地址" },
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
    // Example domains are documentation, not personal data.
    validate: (m) => !/@(?:example|test|invalid|localhost)\./i.test(m),
  },
];

export interface Match {
  start: number;
  end: number;
  value: string;
  ruleId: string;
}

/**
 * Every validated match in `text`, sorted by position with overlaps resolved in
 * favour of the longest — a card number inside a longer digit run should win
 * over a phone-shaped fragment of it.
 */
export function findMatches(text: string): Match[] {
  const found: Match[] = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const m of text.matchAll(re)) {
      const value = m[0];
      if (rule.validate && !rule.validate(value)) continue;
      found.push({ start: m.index, end: m.index + value.length, value, ruleId: rule.id });
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const kept: Match[] = [];
  let cursor = -1;
  for (const m of found) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }
  return kept;
}
