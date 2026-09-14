# Known issues

Everything currently known to be wrong, incomplete or unverified. Each entry
says what it is, why it matters, and what fixing it looks like.

**This is a running record.** Add to it whenever something is found and not
fixed on the spot; move entries to _Fixed_ rather than deleting them, so the
history of what went wrong stays readable.

Last reviewed against `6b92159` on 2026-09-13. Nothing here is a surprise —
these were found during development and deliberately deferred rather than
missed.

---

## 1. Security — must be fixed before any release

### 1.1 Approval rules generalise by command prefix

**Where:** `packages/agent/src/core/approvals.ts`, `patternFor`

Answering `always` derives a reusable rule from the first two words of the
command. That rule then authorises **any argument tail**:

| Approved once                             | Also permits                        |
| ----------------------------------------- | ----------------------------------- |
| `rm -f build/tmp.txt` → `rm -f*`          | `rm -f -r /`, `rm -f ~/.ssh/id_rsa` |
| `git --no-pager diff` → `git --no-pager*` | `git --no-pager reset --hard`       |

This is inherent to any prefix rule and is not a regression — an earlier
iteration collapsed to the bare binary (`rm*`), which was far worse. It is
contained **today** only because approvals live in memory for one session and
are never written to disk, and because reaching it requires the user to have
typed `always` on a command sharing the same two words.

**Fix:** a denylist of commands that may never be generalised into a rule at
all — `rm`, `dd`, `mkfs`, `shutdown`, `chmod -R`, and similar. Those must
always prompt, every time.

> **Gate:** this denylist **must land in the same change as approvals
> persistence, never after it.** The moment rules survive a restart, the
> containment above disappears.

### 1.2 Symlinks are followed out of the project

**Where:** `packages/agent/src/core/tools/fs.ts`, `resolveInProject`

Path containment resolves against the project root correctly — traversal,
absolute paths, UNC paths and prefix collisions (`/proj` vs `/proj-evil`) are
all refused. But nothing calls `realpath`, so a **symlink inside the repository
pointing outside it** is followed.

`read_file` is auto-tier, so this happens with no prompt: cloning a hostile
repository containing a symlink to `~/.ssh/id_rsa` is enough to exfiltrate it.

`glob` and `grep` are incidentally immune — their walk uses `isDirectory()` /
`isFile()`, which are false for symlinks — but that is luck, not design.

**Fix:** `realpath` the resolved path before the containment check, in
`read_file`, `write_file` and `edit_file`.

---

## 2. Correctness

### 2.1 `~` is not treated as shell chaining

**Where:** `approvals.ts`, `SHELL_CHAINING`

The regex catches `;`, `&`, `|`, backticks, `$`, braces, redirects and newlines,
but not `~`. Harmless in the cases tested so far only because of where the
tilde happens to sit, not by design.

### 2.2 Backslashes in POSIX filenames are reinterpreted

**Where:** `approvals.ts`, `normalizePath`

Backslashes are normalised to `/` so Windows paths match POSIX-style rules. On
POSIX a backslash is a **legal filename character**, so a file genuinely named
`a\b.ts` is treated as `a/b.ts`. Fails closed (re-prompts), so it is a
usability wart rather than a hole.

### 2.3 write_file and edit_file do not check the secret list

**Where:** `packages/agent/src/core/tools/fs.ts`

Only `read_file` consults `isSecretFile`. The agent can therefore overwrite
`.env` or an ssh key. Both are `ask`-tier so nothing happens without approval,
and writing to `.env` is sometimes legitimate — but the diff preview shows the
file being clobbered without flagging what it is.

**Fix:** keep the write allowed, but mark it in the preview.

### 2.4 CN_MOBILE has no checksum to lean on

**Where:** `packages/agent/src/core/redact/rules.ts`

Every other identifier rule validates a checksum. Chinese mobile numbers have
none, so the rule rests on boundary conditions alone: eleven digits starting
`1[3-9]`, not adjacent to another digit. A data file or log full of eleven-digit
identifiers will trip it. It survives the source-corpus regression test, but
that corpus is TypeScript.

**Fix if it proves noisy:** restrict to the allocated prefix ranges — `154`,
`160`/`161`/`163`, `179`, `192`/`194` are not issued — which costs no recall and
removes roughly a fifth of the space. Requiring separators is _not_ the answer
here: Chinese mobiles are written unseparated, so it would gut recall.

### 2.5 Interpreter probing accepts binaries that cannot be spawned

**Where:** `packages/agent/src/core/tools/shell.ts`, `probeInterpreters`

The probe checks PATH presence only. On Windows that matches `.bat` shims and
the Store `python3` redirector stub, neither of which `execFile` can spawn
since CVE-2024-27980. Currently harmless because `python3` is deliberately not
probed on Windows, but the moment the probe list grows this becomes real.

**Fix:** verify with an actual `--version` spawn rather than PATH presence.

---

### 2.6 Input arriving faster than one line per prompt is silently dropped

**Where:** `packages/agent/src/index.ts`, the `readLine` loop

`readline.question()` consumes one line and discards any others that arrived in
the same chunk, because nothing is listening between questions. So:

- **Pasting a multi-line message** — a stack trace, a diff, a log — sends only
  the first line to the model, and the rest vanish with no indication.
- **Piping a script** of commands runs only the first one.

Found while smoke-testing the slash commands: a feed of seven commands executed
two. It is not new, but it is worse than it looks, because paste is how people
hand an agent an error message.

**Fix:** keep a `line` listener on the interface and push into a queue that
`readLine` drains, so lines buffer instead of being dropped. Multi-line paste
also wants to be treated as one message rather than several prompts, which is
a question for the Ink work.

## 3. Not verified

### 3.1 Live media responses

Image, video and speech generation are implemented, and their **request
construction** is tested end-to-end against the real CLI with `--dry-run`
(`packages/commands/tests/agent-platform.test.ts`). What has never run is the
**live response path** — the account's media credits are exhausted and do not
renew.

Two bugs were already caught this way and fixed:

- `video generate --download` takes a `<path>`, not a boolean. It had been
  forced on as a bare switch, so every video generation would have failed.
- `speech synthesize` requires `--voice` through cross-flag validation, which
  is invisible in the `required` field the schema generator reads.

Both would only have surfaced at the moment credits were spent. Assume more of
the same in response handling: download paths, async polling, error shapes.

**To verify when credits exist:** run each of the three interactively, confirm
a file actually lands in the project, and confirm the tool returns its path.
Approval prompts cannot be answered through a pipe — EOF is correctly treated
as deny — so this has to be done by hand.

### 3.2 Redaction is verified on one model and one shape of task

A live run against `qwen-max` confirmed the whole round-trip: the card was
withheld, the model copied `[REDACTED_CARD_1]` through a `write_file` argument
unchanged, the approval diff showed the real digits, and the real digits landed
in the file. The model never saw them.

That is one model, one rule and one tool. Whether other models — and especially
smaller ones — preserve a placeholder rather than paraphrasing, reformatting or
objecting to it is unverified, and it is a property of the model rather than
something a test here can assert.

**Check before relying on it:** placeholder fidelity on whichever model you
actually run, and whether it follows the system prompt's instruction to say it
cannot read a value instead of guessing.

### 3.3 Localization is not complete

UI labels and tool descriptions are localized; some payload strings inside them
are not, so a zh-CN user can see a Chinese prompt followed by an English
refusal. Full inventory and the design rule are in
[design/i18n.md](design/i18n.md).

---

## 4. Code hygiene

### 4.1 Dead code

Confirmed as having no non-test caller:

| Symbol                  | File                     | Note                                                                                                |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `matchesPattern`        | `core/approvals.ts`      | Obsolete once `glob` grew its own `globToRegExp`. Delete it and its tests, or document why it stays |
| `ToolRegistry.dispatch` | `core/tools/registry.ts` | The loop calls `tool.run` directly now                                                              |
| `GATED_ARG.read_file`   | `core/approvals.ts`      | Unreachable — `read_file` is auto-tier, so approvals are never consulted for it                     |
| `ApprovalStore.rules()` | `core/approvals.ts`      | Intentional: the persistence hook. Keep, but say so in a comment                                    |

### 4.2 Tests that are weaker than they look

- **Containment has one test.** Mid-path `..`, absolute paths and the prefix
  collision were all verified by review and by hand, but only
  `../../../etc/passwd` is pinned against regression.
- **No test exercises a single-word approval rule.** One line asserting an `ls`
  rule does not authorise `lsof -i` would restore the coverage lost when that
  test was rebased onto a two-word command.
- **`"an option in second position does not authorise every flag of a binary"`**
  over-claims: it only proves a _different_ second word is rejected. Rename it.

### 4.3 Renderer polish

- `tool_call` writes raw unescaped argument JSON, which gets noisy for large
  payloads.
- `turn_start` is a deliberate no-op. It works because the other events bracket
  themselves with newlines; a blank-line separator would read better.

---

## 5. Repo tooling

### 5.1 The pre-commit hook dirties 37 files on every commit

**Where:** `packages/cli/package.json`, the `generate:reference` script

It runs the generator and then `vp check --fix` over `skills/*/reference/`, but
those regenerated files are never staged. So every commit leaves them modified
in the working tree and you have to `git restore skills/` afterwards.

**Fix:** either stage the regenerated files inside the hook, or stop formatting
files the hook cannot stage. One line either way.

### 5.2 The inherited test suite is red on Windows

`npx vp test --run` at the repo root reports roughly 80 failures across 31
files. **None are in `packages/agent`**, which is green at 229. They fall into
three groups, all inherited:

| Group                                                        | Cause                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `e2e/*` against DashScope — video, speech, quota, permission | Needs live API access and media credits                                   |
| `config-agent-writers.test.ts` (20)                          | Isolates by setting `HOME`; `os.homedir()` reads `USERPROFILE` on Windows |
| File-permission and symlink assertions                       | `expected 438 to be 416` — POSIX modes do not exist on Windows            |
| `knowledge-upload-support.test.ts`                           | Path separator assumptions in a recursive directory walk                  |

Worth knowing before trusting a red root run: the agent's own suite is the one
that says whether this fork's code works.

**Fix:** the `HOME` group should set both variables, as the e2e helpers now do.
The permission and path groups want either Windows-aware assertions or a skip
guard, not a fix to the code they test.

### 5.3 Header check would block edits to inherited `tools/` files

**Where:** `tools/check-headers.mjs`, `isCovered`

Coverage claims all of `tools/**`, but 22 inherited files there have no header.
Nothing fails today because none of them have been touched — the first edit to
e.g. `tools/generate-reference.ts` will demand a header nobody expects.

### 5.4 Minor hook and checker warts

- `.vite-hooks/pre-commit` uses an unquoted `$(git diff --cached …)`, so it
  word-splits on filenames containing spaces.
- `tools/tests/check-headers.test.mjs` is itself covered by `isCovered`, and its
  fixture strings contain the SPDX marker within the scanned head — so it
  satisfies the checker without carrying a real header.
- `import { readFileSync }` sits below the function definitions in
  `check-headers.mjs`. Works via hoisting; unconventional.

---

## 6. Deferred by decision, not defect

These are choices, recorded so they are not mistaken for oversights.

- **The npm package is still `bailian-cli@1.24.0`.** Only the binary was renamed
  to `kuang`. `"bailian-cli"` is the filter key in `pnpm --filter bailian-cli`,
  which the pre-commit hook runs, and it appears in the release whitelist and
  `publish.yml`; AGENTS.md §1 also requires the package versions to move in
  lockstep. Renaming is a task of its own. See [../FORK.md](../FORK.md).
- **Internal libraries keep their upstream names** (`bailian-cli-core`,
  `-runtime`, `-commands`). They are workspace-linked and never installed
  standalone.
- **PII redaction was removed, not ported.** The inherited prototype's rules
  matched ordinary source code and were applied to tool _results_, so every file
  the agent read came back corrupted. A precise, input-only, opt-in replacement
  is future work.

---

## 7. Fixed

Kept rather than deleted, so the record shows what went wrong and when.

| Found      | Issue                                                                                                                                                                                                                                                | Fixed in  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 2026-09-13 | `config.e2e.test.ts` set only `HOME` to isolate the child CLI, so on Windows it wrote agent configs into the developer's real home directory — it overwrote `~/.codex/config.toml`, `~/.codex/auth.json` and `~/.hermes/config.yaml` on this machine | pending   |
| 2026-09-13 | `glob` emitted only files, so the agent reported "there are no subdirectories" when there were six                                                                                                                                                   | `92e3244` |
| 2026-09-13 | `.env` was readable by the auto-tier `read_file`, with no prompt                                                                                                                                                                                     | `92e3244` |
| 2026-09-13 | `arguments: null` on trailing tool-call frames appended the text "null" to the model's JSON, breaking the call                                                                                                                                       | `42093ac` |
| 2026-09-13 | `video generate --download` was forced as a bare switch; the real flag needs a path, so every video generation would have failed                                                                                                                     | `15523b9` |
| 2026-09-13 | `speech synthesize` requires `--voice` via cross-flag validation, invisible to the schema generator                                                                                                                                                  | `15523b9` |
| 2026-09-13 | `usage: null` on delta frames crashed the stream one character into every reply                                                                                                                                                                      | `109eb9f` |
| 2026-09-13 | A repeated-digit run passes Luhn, so `0000000000000000` was read as a card number                                                                                                                                                                    | `c0d989d` |
| 2026-09-12 | 35 formatting issues in generated skill references; resolved incidentally when the formatted state was committed                                                                                                                                     | —         |
