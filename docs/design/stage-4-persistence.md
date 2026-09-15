# Stage 4 — persistence, and the safety it unblocks

Status: **complete.** All tasks done; §1.1 retired from KNOWN_ISSUES. Stage 3 (redaction) is complete; see
[stage-3-redaction.md](stage-3-redaction.md).

## Why these ship together

Three pieces of work look separate and are not.

**Sessions should survive a restart.** It is the largest thing the agent is
missing against Claude Code or Gemini CLI. Close the terminal today and the
conversation is gone.

**Approvals should survive too** — answering `always` and being asked again
tomorrow makes the answer meaningless.

**But the approval rules are not safe to persist yet.** A rule derived from
`rm -f build/tmp.txt` is `rm -f*`, which also authorises `rm -f -r /`. That is
contained today by exactly one thing: the rules die with the process. Writing
them to disk removes the only containment there is.

> **The gate.** The denylist and the derivation fix must land in the _same
> change_ as approvals persistence, never after it. There is no acceptable
> intermediate state.

And session persistence forces a fourth decision. The transcript holds real
secret values — redaction happens on the request, and the transcript keeps the
originals so restoration has something to restore. Writing the transcript to
disk would write secrets to disk.

---

## Design

### The transcript that gets saved is the redacted one

The obvious reading of "a saved session contains secrets" is that sessions need
encryption, or a permission bit, or a warning. All three are worse than the
alternative.

The model has only ever seen the sanitized transcript. That view is complete
for every purpose except showing the user a value they already know. So **the
session file stores the sanitized transcript**, and a session file never
contains a secret at all — not as a promise about file permissions, but as a
property of what was written.

```
in memory        transcript with real values ──sanitize──→ request
on disk                                        (this)  ──→ session file
```

Resuming a session gives the model exactly the history it had. The only loss is
that `[REDACTED_CARD_1]` in scrollback from before the restart no longer
restores to the user's card number, because the vault that knew the mapping is
gone. That is a display detail about old turns, and it is the correct trade
against writing credentials into `~/.bailian`.

### Carrying the vault across a resume

Storing the sanitized transcript settles what reaches disk, but it leaves a
second problem: the vault is in memory, so every placeholder issued before a
restart is dead on resume. The user sees `[REDACTED_CARD_1]` where their card
used to be — and worse, if the model writes that placeholder into a file, the
literal text lands there. Silent corruption, not a display nit.

The corruption half is not specific to resume and is **already fixed**: a
placeholder the vault cannot resolve now refuses the tool call rather than
running it, because a model can invent one at any time. See `Vault.unresolved`.

For the rest, `--save-secrets` persists the vault beside the session,
**encrypted with a passphrase**:

- scrypt to derive the key, AES-256-GCM to seal it, both from `node:crypto`
- the passphrase is asked for on save and on resume, and is never stored
- opt-in; the default remains that nothing is written and placeholders expire

The alternatives were considered and rejected. A key in a file next to the
ciphertext is decoration — anything that can read one reads the other. The OS
keychain (DPAPI, Keychain, libsecret) would make resume unattended, which is
genuinely nicer, but it needs a native module, and a native module is the most
common way a globally installed CLI fails to install at all. Plaintext at
`0600` is defensible against the threat most users describe, but it creates one
file holding every credential the agent has ever seen, and `0600` stops nothing
that runs as the user — which on a desktop is everything.

What encryption actually buys, given the file would be `0600` regardless: the
accidents. `~/.bailian` inside a synced folder, a backup, a shared VM image, a
machine that is not disk-encrypted.

### Approval rules: two fixes, not one

The issue log proposed a denylist. A denylist alone is not enough, and there is
a sharper rule available.

**Refuse to generalise when the second word is an option.** The pattern keeps
the first two words, so `rm -f x` becomes `rm -f*` and `git --no-pager diff`
becomes `git --no-pager*`. In both, the second word is a flag, which means the
pattern has captured no verb — it says what program runs and nothing about what
it does. `rm -f*` authorising `rm -f -r /` is that failure exactly.

A two-word pattern whose second word starts with `-` should therefore derive
nothing, and always prompt. This keeps the patterns that are actually useful —
`pnpm test*`, `git status*`, `cargo build*` — and drops precisely the shape that
was dangerous.

**And a denylist, because some programs are unsafe even with a verb.** `rm`,
`rmdir`, `dd`, `mkfs*`, `shred`, `chmod`, `chown`, `shutdown`, `reboot`, `kill`,
`sudo`, `doas`, `su`, `diskpart`, `format`, `takeown`, `icacls`. These never
produce a rule, so they prompt every time, every session.

**Rules are scoped to a project.** A rule approved in one repository must not
authorise anything in another — `pnpm test*` is a different proposition in a
repo you wrote and a repo you cloned. Persisted rules are keyed by project root.

### Where things live

Under the CLI's existing config directory (`BAILIAN_CONFIG_DIR`, else
`~/.bailian`), so one variable relocates everything:

```
<config>/agent/approvals.json      rules, keyed by project root
<config>/agent/sessions/<id>.json  one file per session
```

Writes are atomic — write a temp file, rename over — because a crash mid-write
must not leave a truncated session or an approvals file that fails to parse and
takes every stored answer with it. A file that cannot be parsed is renamed
aside and treated as absent rather than aborting startup: losing yesterday's
approvals is a nuisance, refusing to launch is a failure.

### Resuming

- `kuang agent --continue` — resume the most recent session for this project
- `kuang agent --resume <id>` — resume a named one
- `/sessions` · `/会话` — list this project's sessions, newest first

Autosave after each turn, not on exit. The common way to lose a session is the
way this one was lost already: the machine crashed.

---

## Tasks

Each ends green: `npx vp check --fix` reports 0 errors, package tests pass.

### Task 1 — `core/store.ts`

Atomic JSON read and write under the config directory. Temp file plus rename,
`0600` on create, parse failure quarantines the file and returns the default.

Test: a write interrupted before rename leaves the previous content intact; a
corrupt file is moved aside and does not throw.

### Task 2 — approval derivation and the denylist

**One change, per the gate above.** `patternFor` refuses when the second word
is an option; a denylist refuses by program name; rules gain a project scope.

Test: `rm -f x`, `git --no-pager diff`, `sudo anything` derive nothing and so
are never covered by a stored rule; `pnpm test --watch` still matches a rule
from `pnpm test build`; a rule stored for project A does not match in project B.

### Task 3 — approvals persistence

Load on start, save on `allow_always`. Only after Task 2 is green.

### Task 4 — `core/session.ts`

The session record: id, project root, model, language, created and updated
timestamps, and the **sanitized** transcript. Save and load, list by project.

Test: a session containing a redacted value round-trips without the real value
appearing anywhere in the file — assert on the file bytes, not on the object.

### Task 4b — `--save-secrets`

The encrypted vault sidecar: scrypt + AES-256-GCM over `node:crypto`,
passphrase prompted on save and on resume, never stored. A wrong passphrase
fails the resume cleanly and leaves the session usable without its vault,
rather than aborting.

Test: the ciphertext contains no plaintext secret; a tampered file fails the
GCM tag rather than decrypting to garbage; a wrong passphrase reports itself
and the session still loads.

### Task 5 — wire into the REPL

Autosave after each turn. `--continue`, `--resume <id>`, and the `/sessions`
slash command with its Chinese name.

Test: a turn taken, the process replaced, and the transcript still there.

### Task 6 — README and issue log

Document what a session file holds and, explicitly, what it does not. Retire
§1.1 from KNOWN_ISSUES and remove the "do not run this against a repository you
do not trust" line from the README, which Task 2 is what finally earns.

---

## Out of scope

- Encrypting sessions, and persisting the vault (`--save-secrets`). A session
  file holding no secrets is the better answer to both.
- Sharing sessions between machines.
- Compaction of long transcripts. Worth doing, unrelated to storage.
