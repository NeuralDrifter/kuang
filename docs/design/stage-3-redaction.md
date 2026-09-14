# Stage 3 — Redaction vault

**Goal:** the agent can work with files and text containing secrets and personal
data without the model ever seeing the real values, while the user sees them
normally.

**Status:** not started.

---

## Why this exists, and why the first attempt failed

The inherited prototype had exactly the right idea: replace sensitive values
with placeholders before the model sees them, restore the real values before
display and before execution. The model reasons about `[REDACTED_PII_1]`; the
user reads `4111 1111 1111 1111`. That design is sound and worth rebuilding.

It was removed in Stage 1 because the **rules** were unusable, not because the
architecture was:

```js
/\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g          // "Canadian SIN" — any nine digits
/\b[A-Za-z]{2}\d{6}\b/g                    // "passport"     — matches ab123456
/\b[A-Za-z]{2}\d{2}[ -]?[A-Za-z0-9]{4,30}\b/g  // "IBAN"     — matches hex digests
```

These fire constantly on ordinary source code. Worse, they were applied to
**tool results**, so every file the agent read came back shredded — it was
reasoning about corrupted code without knowing it.

Two lessons, and they are the whole design:

1. **Match structure, then validate.** Every rule that has a checksum must run
   it. A nine-digit number is not a SIN; a nine-digit number that passes Luhn
   might be. Where no checksum is strong enough, require the separators a
   person would write — a bare nine-digit run is usually an arbitrary id.
2. **A false positive on tool output is a correctness bug, not just noise.**
   Precision is the feature.

---

## Coverage to keep

The prototype's breadth was its strength. All of it stays, with validation
added where the identifier has a checksum:

| Rule                 | Validation                                                       |
| -------------------- | ---------------------------------------------------------------- |
| Credit / debit card  | **Luhn**, 13–19 digits                                           |
| Canadian SIN         | **Luhn**, 9 digits                                               |
| Chinese resident ID  | **ISO 7064 MOD 11-2** check character, plus date sanity          |
| IBAN                 | **ISO 7064 MOD 97-10**, plus per-country length                  |
| French NIR           | **mod 97** control key                                           |
| Singapore NRIC / FIN | **weighted checksum** letter                                     |
| US SSN               | structural: area ≠ 000/666/900-999, group ≠ 00, serial ≠ 0000    |
| UK NINO              | valid prefix (excludes BG, GB, NK, KN, TN, NT, ZZ), valid suffix |
| EU VAT               | country prefix plus that country's length rule                   |
| API keys / tokens    | known prefixes (`sk-`, `ghp_`, `AKIA`, …) plus entropy           |
| Chinese mobile       | `1[3-9]` + 9 digits, **not** adjacent to other digits            |
| North American phone | NANP structure, **not** adjacent to other digits                 |
| Email address        | structural                                                       |
| Private key blocks   | `-----BEGIN … PRIVATE KEY-----`                                  |

The two phone rules are the weakest — they have no checksum — so they carry the
strictest boundary conditions and are the first candidates for `--redact-strict`
if they prove noisy.

**Canadian passport is dropped.** Two letters and six digits describes a
passport, a git short SHA with a prefix, a variable name, and a thousand other
things. There is no checksum to lean on. Keeping it means corrupting code.

---

## Design

### Where it applies

| Direction                     | Redact?                       |
| ----------------------------- | ----------------------------- |
| User input → model            | **yes**                       |
| Tool results → model          | **yes**, validated rules only |
| Model output → user           | **restore**                   |
| Model output → tool execution | **restore**                   |

Redacting tool results is the point — a secret in a config file the agent reads
is exactly the leak worth stopping. The prototype's mistake was doing it with
rules that fired on everything, not doing it at all.

### Restoration must be exact

A placeholder that reaches a tool argument must be restored **before**
execution, or the agent writes `[REDACTED_PII_1]` into a real file. A
placeholder that reaches the user's screen must be restored, or they see
nothing useful.

The prototype's `StreamRestorer` is the one piece to keep almost as-is: it
buffers at a possible placeholder boundary so `[REDACTED_` split across two
stream chunks is not printed raw. That logic was correct.

### Files

```
packages/agent/src/core/redact/
  validators.ts   Luhn, ISO 7064 MOD 11-2, MOD 97-10, NRIC, NIR, entropy
  rules.ts        The rule table: pattern + validator + label
  vault.ts        Vault: sanitize / restore / placeholder map
  stream.ts       StreamRestorer, ported from the prototype
```

`vault.ts` holds a bidirectional map so the same value always gets the same
placeholder within a session — the model can refer back to
`[REDACTED_CARD_1]` and mean the same card.

Placeholders name their kind: `[REDACTED_CARD_1]`, `[REDACTED_EMAIL_2]`. The
model reasons better about a labelled hole than an anonymous one.

### Opt-in

Off by default behind `--redact`, until the false-positive rate is known on
real projects. Turning it on must never be the reason the agent misreads a
file, so the default stays the conservative one until there is evidence.

---

## Tasks

Each ends green: `npx vp check --fix` reports 0 errors, package tests pass.

### Task 1 — `validators.ts`

Pure functions, no I/O. `luhn`, `iso7064Mod11_2`, `iso7064Mod97_10`,
`nricChecksum`, `nirKey`, `shannonEntropy`.

Test each against a known-good value **and** a one-digit mutation of it, so the
test proves the checksum discriminates rather than merely returning true.
Independently-sourced vectors where they exist: Luhn `4111111111111111`,
IBAN `GB82WEST12345698765432`.

### Task 2 — `rules.ts`

The table above, each entry `{ id, label, pattern, validate? }`. A match is
only redacted when `validate` passes.

**The critical test:** run every rule over a corpus of this repository's own
source files and assert **zero** matches. That is the regression the prototype
failed, and it is the one that matters most.

### Task 3 — `vault.ts`

`sanitize(text)` → text with placeholders; `restore(text)` → original values;
stable placeholders per value; `stats()` for a summary line.

Test: round-trip fidelity, stable numbering, overlapping matches resolved
longest-first, and that restore is exact including adjacent punctuation.

### Task 4 — `stream.ts`

Port `StreamRestorer` from the prototype's git history — the boundary buffering
was correct. Test a placeholder split across every possible chunk boundary.

### Task 5 — wire into the loop

`runTurn` takes an optional vault. Sanitize user messages and tool results on
the way in; restore tool-call arguments before execution and text deltas before
they reach the renderer.

Test: a tool call whose argument is a placeholder executes with the real value;
the transcript sent to the model contains no real secret.

### Task 6 — `--redact` flag and README

Off by default. Document what is covered, what is not, and that it is
best-effort — a redaction layer is a safety net, not a guarantee.

---

## Out of scope

- Redacting what the user _types_ back after seeing a restored value. They are
  the source of truth for their own screen.
- Persisting the placeholder map across sessions. Within a session only.
- The other two security items — the command denylist and `realpath`
  containment — which are tracked in [../KNOWN_ISSUES.md](../KNOWN_ISSUES.md).
  Redaction is independent of both.
