# Known issues

Everything currently known to be wrong, incomplete or unverified. Each entry
says what it is, why it matters, and what fixing it looks like.

**This is a running record.** Add to it whenever something is found and not
fixed on the spot; move entries to _Fixed_ rather than deleting them, so the
history of what went wrong stays readable.

Last reviewed against `a526712d` on 2026-09-18. Nothing here is a surprise —
these were found during development and deliberately deferred rather than
missed.

---

## 1. Security — must be fixed before any release

**Nothing outstanding.** Both entries that lived here are closed:

- Approval rules no longer generalise from a pattern that names no verb, and a
  denylist covers the programs that are unsafe even with one. The fix shipped
  **before** persistence, which is the order the gate required.
- Path containment resolves symlinks and junctions, on the project root as well
  as the target.

What a stored rule still does — cover the argument tail after a verb, so
`npm run build` permits `npm run <script>` — is the feature working, and is
recorded under §6 rather than here.

## 2. Correctness

### 2.1 CN_MOBILE has no checksum to lean on

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

---

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

Cleared. `matchesPattern` and `ToolRegistry.dispatch` are deleted — the glob
tool grew its own translation and the loop runs tools directly.
`ApprovalStore.rules()` turned out not to be dead at all: it is what the
persistence hook reads.

`GATED_ARG.read_file` stays and is still unreachable, because `read_file` is
auto-tier so approvals are never consulted for it. It is left deliberately: the
entry is what would have to change first if that tier were ever raised, and
removing it would hide that.

### 4.2 Tests that are weaker than they look

Cleared. Containment now has symlink and junction cases (the junction ones run
on Windows, where unprivileged symlinks are refused, so the check is not
untested on the platform it was written on). The single-word approval rule is
pinned — approving `ls` does not authorise `lsof -i`. And the test that claimed
an option in second position "does not authorise every flag of a binary" only
ever proved that a _different_ second word was rejected; it is renamed to what
it actually shows, and the behaviour it seemed to promise is now covered by the
rule that such a pattern is never derived at all.

### 4.3 Renderer polish

- `tool_call` writes raw unescaped argument JSON, which gets noisy for large
  payloads.
- `turn_start` is a deliberate no-op. It works because the other events bracket
  themselves with newlines; a blank-line separator would read better.

---

## 5. Repo tooling

### 5.1 The inherited test suite is red on Windows

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

### 5.2 Header check would block edits to inherited `tools/` files

**Where:** `tools/check-headers.mjs`, `isCovered`

Coverage claims all of `tools/**`, but 22 inherited files there have no header.
Nothing fails today because none of them have been touched — the first edit to
e.g. `tools/generate-reference.ts` will demand a header nobody expects.

### 5.3 Minor hook and checker warts

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

- **An approval rule covers the argument tail after its verb.** `npm run build`
  approved once permits `npm run <any script>`. A rule that covered only the
  exact command already approved would not be worth storing, so this is the
  feature rather than a gap. Commands that could chain are refused at
  derivation _and_ at matching, and the denylist and verb rule bound what can
  become a rule at all.

- **82 upstream tests fail on Windows, and are left alone.** `vp test` across
  the whole repo reports 82 failures in 32 files, none of them in
  `packages/agent` and none from our own code. Two causes, both inherited:
  - **`os.homedir()` is read on Windows but `HOME` is what the test sets.**
    `config-agent-writers.test.ts` and `core/tests/skills-agents.test.ts`
    isolate the filesystem with `process.env.HOME = <tmpdir>`, and their own
    comment says why it works — "homedir() reads $HOME on POSIX". Node reads
    `USERPROFILE` on Windows, so the isolation does nothing and the code
    resolves the real home. These fail on a guard in `beforeEach`, so they
    abort before writing anything; unlike §7's `config.e2e.test.ts` entry,
    nothing reaches the developer's home directory. Fixing it means setting
    `USERPROFILE` alongside `HOME` in two upstream files — declined, because
    upstream develops and runs CI on POSIX, and editing their tests widens the
    merge surface against a repo taking ~31 commits a week for no benefit to us.

  - **Some e2e tests need live credentials.** `quota.e2e.test.ts` and
    `speech-recognize.e2e.test.ts` call the real API and fail with
    `Workspace access denied`. Environmental, not a defect.

  Verified pre-existing rather than assumed: the full suite was run at
  `9b650078` before merging `upstream/main` and again after, and both reported
  exactly 82 failures. **Use `vp test packages/agent` as the working signal**;
  the repo-wide number is not expected to be zero on Windows.

- **The npm package is still `bailian-cli@1.25.0`.** Only the binary was renamed
  to `kuang`. `"bailian-cli"` is the filter key in `pnpm --filter bailian-cli`,
  which the pre-commit hook runs, and it appears in the release whitelist and
  `publish.yml`; AGENTS.md §1 also requires the package versions to move in
  lockstep. Renaming is a task of its own. See [../FORK.md](../FORK.md).
- **Internal libraries keep their upstream names** (`bailian-cli-core`,
  `-runtime`, `-commands`). They are workspace-linked and never installed
  standalone.
- **PII redaction was rewritten, not ported.** The inherited prototype's rules
  matched ordinary source code and were applied to tool _results_, so every file
  the agent read came back corrupted. The replacement shares nothing with it but
  the stream-buffering idea: checksum-validated rules, a single sanitize point on
  the request, and restoration on the way out. Shipped in Stage 3; see
  [design/stage-3-redaction.md](design/stage-3-redaction.md).

---

## 7. Fixed

Kept rather than deleted, so the record shows what went wrong and when.

| Found                                                                                                                                                                                                                                                | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fixed in   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2026-09-18                                                                                                                                                                                                                                           | Panes mode rendered empty on a real terminal while every probe showed correct frames. The root box was the exact terminal size and Ink pads every row to that width, so ~46 full-width rows per frame each landed in the last column and scrolled the terminal a line; the conversation, always at the frame's top, was pushed out of view while older frames' scrollbars stayed visible and looked like a stable, empty UI. Diagnosed by capturing the real stdout to a file — buffers cannot scroll, so synthetic probes could never reproduce it | `a526712d` |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-09-15                                                                                                                                                                                                                                           | `~` was not treated as shell chaining in the approval gate regex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `b7cf16db` |
| 2026-09-15                                                                                                                                                                                                                                           | Backslashes in POSIX filenames were reinterpreted incorrectly in `normalizePath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `b7cf16db` |
| 2026-09-15                                                                                                                                                                                                                                           | `write_file` and `edit_file` preview diffs exposed the contents of secret files being clobbered                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `b7cf16db` |
| 2026-09-15                                                                                                                                                                                                                                           | Interpreter probing used PATH presence instead of spawning, which on Windows matched unspawnable `.bat` and Store stub redirects                                                                                                                                                                                                                                                                                                                                                                                                                    | `b7cf16db` |
| 2026-09-15                                                                                                                                                                                                                                           | The Ink UI did not support input history navigation, cursor movement, or in-line editing for the draft prompt                                                                                                                                                                                                                                                                                                                                                                                                                                       | `7cc34f9b` |
| 2026-09-15                                                                                                                                                                                                                                           | The Ink UI did not implement a passphrase prompt, rendering `--save-secrets` and `/pii save` unusable                                                                                                                                                                                                                                                                                                                                                                                                                                               | `7cc34f9b` |
| 2026-09-15                                                                                                                                                                                                                                           | JSX was transformed by whichever tsconfig the runner found, so the Ink UI worked in tests run from `packages/agent` and failed with "React is not defined" when launched from `packages/cli`                                                                                                                                                                                                                                                                                                                                                        | `f28c9db`  |
| 2026-09-15                                                                                                                                                                                                                                           | The Ink path wired an asker that resolved to undefined, so every ask-tier tool was refused while telling the user they had denied it                                                                                                                                                                                                                                                                                                                                                                                                                | `pending`  |
| 2026-09-15                                                                                                                                                                                                                                           | A two-word approval pattern ending in an option captured no verb, so `rm -f build/tmp.txt` approved once also authorised `rm -f -r /`; an existing test asserted this behaviour rather than catching it                                                                                                                                                                                                                                                                                                                                             | `b7cf16db` |
| 2026-09-14                                                                                                                                                                                                                                           | Input arriving faster than one line per prompt was discarded, so pasting a stack trace sent only its first line and piping a script ran only its first command                                                                                                                                                                                                                                                                                                                                                                                      | `pending`  |
| 2026-09-14                                                                                                                                                                                                                                           | A symlink or junction inside the project was followed out of it, and `read_file` is tier `auto` — cloning a hostile repository was enough to read `~/.ssh/id_rsa` with no prompt                                                                                                                                                                                                                                                                                                                                                                    | `pending`  |
| 2026-09-14                                                                                                                                                                                                                                           | The formatter and `generate-reference.ts` both claimed `skills/*/reference`, so each commit left 34 files dirty — and the formatter escaped markdown inside flag docs, teaching the model config keys that do not exist (`base*url` for `base_url`)                                                                                                                                                                                                                                                                                                 | `pending`  |
| 2026-09-13                                                                                                                                                                                                                                           | `config.e2e.test.ts` set only `HOME` to isolate the child CLI, so on Windows it wrote agent configs into the developer's real home directory — it overwrote `~/.codex/config.toml`, `~/.codex/auth.json` and `~/.hermes/config.yaml` on this machine                                                                                                                                                                                                                                                                                                | pending    |
| 2026-09-13                                                                                                                                                                                                                                           | `glob` emitted only files, so the agent reported "there are no subdirectories" when there were six                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `92e3244`  |
| 2026-09-13                                                                                                                                                                                                                                           | `.env` was readable by the auto-tier `read_file`, with no prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `92e3244`  |
| 2026-09-13                                                                                                                                                                                                                                           | `arguments: null` on trailing tool-call frames appended the text "null" to the model's JSON, breaking the call                                                                                                                                                                                                                                                                                                                                                                                                                                      | `42093ac`  |
| 2026-09-13                                                                                                                                                                                                                                           | `video generate --download` was forced as a bare switch; the real flag needs a path, so every video generation would have failed                                                                                                                                                                                                                                                                                                                                                                                                                    | `15523b9`  |
| 2026-09-13                                                                                                                                                                                                                                           | `speech synthesize` requires `--voice` via cross-flag validation, invisible to the schema generator                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `15523b9`  |
| 2026-09-13                                                                                                                                                                                                                                           | `usage: null` on delta frames crashed the stream one character into every reply                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `109eb9f`  |
| 2026-09-13                                                                                                                                                                                                                                           | A repeated-digit run passes Luhn, so `0000000000000000` was read as a card number                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `c0d989d`  |
| 2026-09-12                                                                                                                                                                                                                                           | 35 formatting issues in generated skill references; resolved incidentally when the formatted state was committed                                                                                                                                                                                                                                                                                                                                                                                                                                    | —          |
