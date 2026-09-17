# Kuang 匡 — Agent TUI Design

**Date:** 2026-09-12
**Author:** Michael P. Burgus (<https://github.com/NeuralDrifter>)
**Status:** Core implemented; platform tool surface and UI outstanding

> **匡** (kuāng) — to correct, to rectify, to assist. 匡正 _to set right_;
> 匡扶 _to support and uphold_. What an agent is for.

**Notation.** `bl` refers to the inherited upstream binary and to subsystems as
they exist today; `kuang` refers to this fork's commands after the identity
change (§12.1). They are the same binary, renamed.

---

## 1. Goal

Give the CLI a first-class interactive agent — a terminal UI of the same class as
Claude Code, Gemini CLI and Codex — that is simultaneously:

- a **coding agent** (read, write, edit, search, run commands), and
- a **Bailian platform agent** that can reach every capability the CLI already
  exposes: image, video, speech, vision, knowledge bases, finetuning,
  deployment, sandboxes, web search, managed agents.

The agent must be fully bilingual (`en-US` / `zh-CN`) in both directions: its
own interface, and the language it replies in.

### The central observation

`bl skill add` detects installed agents — Claude Code, Cline, Warp, Zed, Kimi,
Amp, Replit — and symlinks skill packs into _their_ directories
(`packages/core/src/skills/agents.ts`). This CLI has spent its entire existence
authoring expertise for other people's agents and has never had one of its own.

We are not building a platform. Five subsystems already work: skills, command
packs, MCP, memory, and platform permissions. We are building the **host layer**
that was always missing — UI, agent loop, local OS tools, approvals, sessions.

### The operating principle

Agent decisions must be **observable, auditable and reversible**, so that
failures are caught early and understood quickly.

An agent that edits files faster than anyone can read about it is only useful
if you can trust it, and trust is not a property of the model — it is a
property of what the interface lets you see and undo. The three words are the
means; the last clause is the goal, and it is the one to test a design against:

- **Observable** — what the agent is doing is visible while it happens, not
  reconstructable afterwards from a log. This makes latency a requirement:
  showing a change when the turn ends is too late, because by then five more
  edits sit on top of the wrong one.
- **Auditable** — what it did stays readable after the fact, in a form that
  answers "is this right?" before it answers "what exactly happened?".
  Legibility beats completeness; the detail belongs one scroll away rather
  than in the way.
- **Reversible** — a wrong change can be undone without reconstructing the
  original by hand. This mostly costs nothing at the time, provided earlier
  stages keep what a later one would need to restore.

Approvals (§7) were the first of these, and gate what happens _before_ an
action. The stages that follow cover what happens after one: the live diff
panel is the observable half ([stage-6-diff-panel.md](stage-6-diff-panel.md)),
with auditability and reversal built on the baselines it keeps.

---

## 2. Non-goals

- Not a general LLM client. It is pinned to Bailian/DashScope.
- No multi-provider abstraction. Provider selection is settled by definition.
- No web or desktop UI. Terminal only.
- Not upstream-compatible. This is a fork and will diverge deliberately.
- Not replacing `bl`'s non-interactive commands. `kuang agent` is additive; every
  existing command keeps working exactly as it does today.

---

## 3. What we inherited

### 3.1 The prototype

`packages/commands/src/commands/agent/index.ts` — ~380 lines, added across five
commits on 2026-09-12. It establishes the shape: SSE streaming, a tool-call
loop, history persistence, a `@clack/prompts` REPL.

It is a prototype and is **replaced**, not extended. Defects that inform the
design:

| Defect                                                       | Location                     | Consequence                                          |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------- |
| `execute_bash` runs model output with no approval            | `index.ts` `localTools`      | Arbitrary code execution                             |
| Redaction regexes match ordinary text                        | `RedactionVault.rules`       | Corrupts every file read                             |
| Redaction applied to tool results                            | `sanitize(result)`           | Model sees mangled source                            |
| Two assistant messages when a turn has text _and_ tool calls | `~:319` then `~:326`         | Corrupt transcript                                   |
| `/apikey` shells `npx tsx packages/cli/src/main.ts`          | `/apikey`, `/url` handlers   | Repo-root-only; shell injection                      |
| No tool-loop iteration cap                                   | `while (requireAnotherTurn)` | Unbounded spend                                      |
| `execSync(cmd)` with no shell selection                      | `execute_bash`               | Routes through `cmd.exe` on Windows                  |
| History in `process.cwd()`                                   | `historyFile`                | Litters every directory                              |
| `/restart` respawns the process                              | `doRestart()`                | Fragile                                              |
| No error recovery                                            | Stream request               | One failure ends the session                         |
| **`settings.language` does not exist**                       | `~:153`                      | `isZH` always false; every zh-CN string is dead code |
| Does not typecheck; `process.exit()` violates lint           | `~:153`, `~:202`             | `main` is red; pre-commit blocks all commits         |
| No tests                                                     | —                            | —                                                    |

The language defect is the most consequential. `Settings` has no `language`
field — it lives on `ConfigFile`, reached via `ctx.sources.file.language`
(cf. `packages/runtime/src/middleware.ts:76`). `settings.language` is therefore
`undefined` on every run, `isZH` is permanently false, and a zh-CN user gets an
entirely English agent. The bilingual requirement fails at the first line that
tests it. See §8.

Specific redaction failures, for the record: `\b[A-Za-z]{2}\d{6}\b` matches
`ab123456`; `\b[A-Za-z]{2}\d{2}[ -]?[A-Za-z0-9]{4,30}\b` (IBAN) matches hex
digests and identifiers; `\b\d{3}[ -]?\d{3}[ -]?\d{3}\b` matches any nine
digits.

### 3.2 Subsystems we build on

| Subsystem                            | Reuse                               |
| ------------------------------------ | ----------------------------------- |
| `bl skill` + `skills/bailian-*`      | Domain knowledge layer (§6)         |
| `bl plugin` (Command Packs)          | Third-party tools, zero code change |
| `bl mcp`                             | MCP servers as a tool source        |
| `bl memory`                          | Cross-session persistent memory     |
| `LocalizedText` / `createTranslator` | All i18n; no new system             |
| `FlagsDef`                           | Generated tool schemas (§5.2)       |

### 3.3 The generator insight

`packages/core/src/types/command.ts` defines:

```ts
type LocalizedText = string | { "en-US": string; "zh-CN": string };
interface ValueFlag {
  type: "string" | "number" | "boolean" | "array";
  description: LocalizedText;
  valueHint: string;
  required?: boolean;
  choices?: readonly string[];
}
```

This is JSON Schema in all but name, and it is already bilingual. All 228
commands in `packages/cli/src/commands.ts` can be converted to tool definitions
**mechanically**, in either language, with no hand-written schemas and no
possibility of drift from the real CLI.

---

## 4. Architecture

New package `packages/agent` (`kuang-agent`), between `commands` and the
product entry.

```
packages/agent/src/
  core/                   pure — no I/O, no React, unit-testable
    loop.ts               turn loop: stream -> tool calls -> results -> repeat
    events.ts             the event stream the UI subscribes to
    session.ts            transcript, persistence, resume, compaction
    approvals.ts          rule matching, allowlist, persistence
    redact.ts             rewritten vault
    language.ts           enforcement + drift detection
    skills.ts             discovery, tiered loading, host adaptation
    tools/
      registry.ts         Tool interface, dispatch, name collision handling
      generate.ts         FlagsDef -> JSON Schema; manifest -> JSON Schema
      fs.ts               read / write / edit / glob / grep
      shell.ts            interpreter selection, timeout, cancellation
      bailian.ts          generated bl surface (hot set + discovery)
      scripts.ts          bundled script toolkit
      mcp.ts              MCP servers as tools
  ui/                     Ink/React — no business logic
    App.tsx  Transcript.tsx  ToolCall.tsx  Approval.tsx  StatusLine.tsx
    Markdown.tsx  Media.tsx  Input.tsx  Diff.tsx  SlashMenu.tsx
  scripts/                bundled toolkit (§5.3)
  index.ts                runAgent(ctx)
```

`packages/commands/src/commands/agent/index.ts` becomes a ~20-line launcher
that hands `ctx` to `runAgent`.

### 4.1 The rule that makes this testable

**`core` never imports from `ui`.** The loop emits typed events; the UI
subscribes. The entire agent runs headless in tests, asserting on the event
stream. No terminal, no React, no snapshots required to test behaviour.

```ts
type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_approval_required"; id: string; preview: Preview }
  | { type: "tool_result"; id: string; ok: boolean; summary: string }
  | { type: "turn_end"; usage: Usage }
  | { type: "error"; error: AgentError };
```

### 4.2 Layering

Respects `AGENTS.md` §2: `core` stays pure, `runtime` stays generic, `commands`
stays a command library, and the agent runtime is its own layer. `packages/agent`
may depend on `core`, `runtime` and `commands`; none of them may depend on it.

---

## 5. Tool layer

Five sources, one registry, one generator.

### 5.1 Coding tools (hand-written)

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `shell`.

`shell` takes an explicit `interpreter: "pwsh" | "bash" | "python"` rather than
assuming bash. The prototype's `execSync(command)` silently routes through
`cmd.exe` on Windows, which breaks most of what a model emits. Interpreters are
probed at startup; only available ones are offered in the enum.

### 5.2 Generated `bl` surface — hybrid

228 commands cannot all be tool schemas. Two tiers:

**Hot set** — promoted to first-class tools with tuned descriptions:
`generate_image`, `generate_video`, `text_to_speech`, `transcribe_audio`,
`describe_image`, `search_web`, `retrieve_knowledge`.

**Tail** — reached through discovery meta-tools: `bl_search_commands`,
`bl_describe_command`, `bl_run_command`.

Cost: roughly 2.5k tokens resident for the capabilities actually used, with the
whole platform still reachable. Alternatives rejected: all-228 (impossible),
namespace tools (~6–10k permanent tax; `managed-agent` alone has 60+
subcommands).

Generated calls pass `--output json` so tool results are structured data rather
than prose — which also limits Chinese output flooding the context (§8).

### 5.3 Bundled script toolkit

So the model stops reinventing basic capability. Without this, an LLM will write
a bespoke pypdf script every session, get it subtly wrong, and burn thousands of
tokens.

```
packages/agent/scripts/
  doc/    pdf_extract  docx_to_md  xlsx_to_csv  ocr
  audio/  transcribe   convert     trim         normalize
  image/  resize       convert     exif         contact_sheet
  video/  extract_frames  probe    clip
  data/   csv_stats    json_query
```

Each script carries a manifest (bilingual description, param schema) which
`generate.ts` converts to a tool schema — the same generator, a second source.
Adding a capability later means dropping in a file.

**Dependencies via `uv` + PEP 723 inline metadata**, which avoids venvs and
`requirements.txt` entirely:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pypdf>=5.0", "pillow"]
# ///
```

`uv run` resolves and caches per-script. **Degradation:** at startup the agent
probes for `uv`, then `python3`, then `ffmpeg`. Unavailable tools simply do not
register, and the system prompt says so — the model falls back to writing code,
which is today's behaviour. Nothing breaks; the install stays optional.

### 5.4 MCP servers

`bl mcp` is already an MCP client. Configured servers' tools register into the
same registry, namespaced `mcp__<server>__<tool>`.

### 5.5 Command Packs

Installed packs extend the command tree, so §5.2's generator picks them up
automatically. Third-party tools with zero agent code.

---

## 6. Skills as the knowledge layer

`skills/bailian-*/SKILL.md` is **Anthropic's Agent Skills format** — `name` +
`description` frontmatter, body, `reference/` and `assets/` subdirectories. It
was built to feed Claude Code, so it is natively three-tier.

### 6.1 Progressive disclosure

| Tier | Content                           | Cost           | Loaded              |
| ---- | --------------------------------- | -------------- | ------------------- |
| 1    | 7 pack `description` fields       | ~1.2k tokens   | Always              |
| 2    | `SKILL.md` body (5–17 KB)         | 1.5k–4.5k each | On task match       |
| 3    | `reference/*.md` (to 2,190 lines) | Large          | On explicit request |

Eager loading of all seven would cost ~20k tokens permanently. Tiering makes it
~1.2k.

### 6.2 Host adaptation — required

These skills were written for a **foreign host** where `bl` is an external
binary. Four of the ten sections in `bailian-protocol/SKILL.md` misfire when the
host _is_ `bl`:

- **"Host-only"** routing: _"Answer with the host agent's native capabilities.
  Do not invoke `bl`."_ — there are no native capabilities separate from Bailian.
- **Provider consent**: _"ask once before the first call"_ — asking permission
  to use Bailian, inside the Bailian agent.
- **Version pre-flight** / **Setup & auth**: handle `bl` being absent or stale.
  We are the running binary.
- **Trivial image Q&A** _"the host can answer natively to save cost"_ — our host
  cannot see images except through Bailian.

Retained verbatim: high-risk confirmation, the local-files rule, **"Respond in
the user's language"**, error reporting.

**Mechanism:** a ~200-token host-context preamble injected above any loaded
skill, stating that the agent _is_ the host, that provider selection is settled,
that version and setup checks are skipped, that tools are called directly rather
than via shell `bl` invocations, and that high-risk confirmation still applies
through the approvals system (§7).

A second mapping layer rewrites skill-documented invocations (`bl image ...`)
onto real tool names (`generate_image`), or the model will try to shell out to a
binary it is already inside.

This leaves upstream packs untouched, so `bl skill update` keeps working.

### 6.3 Bilingual frontmatter — a fix

All seven `description` fields are **Chinese-only**, unlike the bilingual command
tree. Under §6.1 that puts ~1.2k tokens of Chinese routing text permanently in
an English user's system prompt — a direct contributor to the drift in §8.

**Fix:** extend frontmatter to `LocalizedText`:

```yaml
description:
  en-US: >-
    ...
  zh-CN: >-
    ...
```

Consistent with the repo's own convention. `tools/sync-skill-metadata.ts` must
be updated to preserve both. Worth upstreaming.

---

## 7. Approvals

**Naming:** `bl permission` already means _model_ permissions
(inference/finetune/deploy) on the platform. Local tool gating is called
**approvals** throughout — `~/.bailian/agent/approvals.json`, `/approvals`.

| Tier  | Tools                                            | Behaviour                             |
| ----- | ------------------------------------------------ | ------------------------------------- |
| Auto  | read, glob, grep, describe, search, list, probe  | Silent                                |
| Ask   | write, edit, shell, generate\_\*, any `bl` write | Prompt: `y` / `n` / `always` / `edit` |
| Never | destroy, delete, `--yes` injection               | Refused; model told why               |

`always` persists a **pattern**, not a literal: `shell(pnpm test:*)`,
`write(src/**)`. Write and edit show a **diff preview before** approval.
`--dangerously-skip-permissions` exists behind a loud banner.

Tool-loop iteration cap (default 25, `--max-turns`) and a per-session spend
guard.

---

## 8. Language

Qwen drifts to Chinese. This is not a config bug — `DEFAULT_LANGUAGE` is
`en-US` and the local config carries no `language` field, so the prototype
already sends the English system prompt. The drift has three real causes:
Qwen's training bias, Chinese-heavy `bl` command output entering context, and
(under §6) Chinese skill descriptions sitting permanently in the system prompt.

Four mechanisms, because one is insufficient:

1. **First-run language picker**, persisted to `settings.language`, before
   anything else runs.
2. **Localized system prompt** — for output consistency, not token economy.
   Chinese and English are near parity under Qwen's tokenizer (~1.5–1.7 chars/
   token for Chinese vs ~3.5–4 for English, against roughly half the character
   count); the system prompt is a fixed, cacheable cost while the real burn is
   file contents and tool results, which are language-neutral.
3. **Reasserted directive** — re-injected as a trailing system reminder each
   turn so it does not decay as Chinese tool output accumulates. This is the
   mechanism that actually fixes the observed drift.
4. **`--output json` on generated `bl` calls** — structured data instead of
   Chinese prose.

Plus §6.3's bilingual descriptions, which removes the largest resident source.

All UI strings, slash commands, errors and help go through typed
`LocalizedText` via the existing `createTranslator`. `/help` shows both forms.

---

## 9. Redaction

Rewritten, and **demoted**:

- **Precise rules**, validated not merely matched: Luhn for cards, checksum for
  Chinese resident IDs, ISO-7064 for IBAN.
- **Input only.** Never applied to tool results. The prototype's corruption of
  file contents is the single worst defect it has.
- **Off by default**, behind `--redact`.

The `StreamRestorer` boundary-buffering approach is sound and is kept.

---

## 10. Session

`~/.bailian/agent/sessions/<id>.json` — never `process.cwd()`.
`kuang agent --resume` offers a picker. Auto-compaction as context approaches the
model window. `/restart`'s process respawn is removed; `/apikey` and `/url`
call the config API in-process.

Optional integration with `bl memory` for cross-session persistent memory.

---

## 11. Media rendering

Generated images and video frames render **inline** — Kitty and iTerm2 graphics
protocols where supported, sixel fallback, path plus dimensions otherwise.
Files land in the project, not a temp directory. This is the core of "make an
image in the project" feeling native rather than like a download.

---

## 12. Licensing and fork hygiene

Upstream: Apache-2.0, `Copyright 2026 Aliyun Model Studio (DashScope) AI
Platform`. **No `NOTICE` file** (so §4(d) does not apply) and **no per-file
copyright headers**.

One hard obligation — Apache-2.0 **§4(b)**: modified files must carry prominent
notices stating they were changed.

1. `LICENSE` stays byte-identical, Aliyun's copyright included.
2. Add `NOTICE` recording the fork lineage and Michael P. Burgus's copyright.
3. **New files:**
   ```
   // Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
   // SPDX-License-Identifier: Apache-2.0
   ```
4. **Modified inherited files** (the §4(b) notice):
   ```
   // SPDX-License-Identifier: Apache-2.0
   // Modified 2026 by Michael P. Burgus <https://github.com/NeuralDrifter>
   // Original: bailian-cli, Copyright 2026 Aliyun Model Studio (DashScope) AI Platform
   ```
5. `FORK.md` recording what diverged and why.
6. `tools/check-headers.mjs` in `.vite-hooks/pre-commit`. The earlier
   agent commits get back-filled in the same pass.

### 12.1 Project identity

Apache-2.0 §6 grants no trademark rights. "Aliyun", "Bailian", "Model Studio"
and "DashScope" are Alibaba marks: usable descriptively ("a fork of
bailian-cli"), not as our identity.

Distribution is GitHub-only — no npm publish — but `npm i -g github:<user>/<repo>`
still installs the package under whatever `name` and `bin` it declares, so the
identity fields matter regardless of the registry.

| Field               | Upstream                   | Fork         |
| ------------------- | -------------------------- | ------------ |
| Project             | Bailian CLI                | **Kuang 匡** |
| Repo                | `Aliyun-Model-Studio-CLI`  | `kuang`      |
| Binary              | `bl`, `bailian`            | `kuang`      |
| `packages/cli` name | `bailian-cli`              | `kuang`      |
| Version             | `1.24.0`                   | `0.1.0`      |
| `homepage`          | Alibaba console            | fork README  |
| `bugs.url`          | `modelstudioai/cli/issues` | fork issues  |
| `repository`        | `modelstudioai/cli`        | fork         |

**Rationale.** 匡 (kuāng) — to correct, to rectify, to assist (匡正, 匡扶).
Uncommon enough to own, semantically exact, and pronounceable in English.
Verified clear: free on PATH; the `kuang` npm package is a dead 2020
placeholder (v0.0.1, one version, **no `bin`**, untouched since 2022) so there
is no command collision; no notable GitHub project.

Rejected: `miao` 妙 — `captain-miao` ships a `miao` binary in the same niche
(TUI for coding-agent sessions); `deft` — `deftai` org already brands AI-agent
CLI tooling; `atl`/`atelier`, `kiln`, `loom` — generic. `篡` was rejected on
meaning: 篡改 is _to tamper with / falsify_, alarming on a tool that edits files.

**Non-negotiable regardless of naming:** `bugs`, `repository` and `homepage`
currently direct our users to file issues on Alibaba's tracker for code they
did not write. `bl` also collides with a real bailian-cli install already
present on the developer's PATH.

**Deliberately unchanged:** internal libraries `bailian-cli-core`,
`bailian-cli-runtime`, `bailian-cli-commands`, and `kscli`. They are
workspace-linked, never installed standalone, and renaming them is churn.
Revisit only if the project is ever published to a registry.

**README disclaimer:** _Kuang 匡 is an independent fork of Aliyun's bailian-cli.
Not affiliated with, endorsed by, or supported by Alibaba._

---

## 13. Testing

- **`core` headless.** The loop, tool dispatch, approvals, redaction, session
  and language enforcement are tested against the event stream with a mocked
  SSE transport. No terminal involved.
- **Generator golden tests.** `FlagsDef` -> JSON Schema, both languages,
  snapshotted, so upstream flag changes surface as diffs.
- **Approval matrix.** Every tool asserted into exactly one tier; a new tool
  without a tier declaration fails the build.
- **Redaction corpus.** Real source files asserted **unchanged** — the
  regression that matters most.
- **Ink smoke tests** via `ink-testing-library`, kept thin.
- **E2E** per `docs/agents/cli-e2e-tests.md`: help, missing args, dry-run.

---

## 14. Build sequence

Ordered so something usable exists early rather than at the end.

0. **Identity change** (§12.1): binary, `packages/cli` name, version reset,
   `bugs`/`repository`/`homepage`, README disclaimer, repo rename. Done first
   so no later work bakes in the old identity.
1. Package scaffold, licensing headers, header check hook.
2. `core/events.ts` + `core/loop.ts` with mocked transport. Tests first.
3. Tool registry + `generate.ts`, golden tests.
4. Coding tools (`fs`, `shell` with interpreter selection).
5. Approvals, including the diff preview.
6. **Plain-text renderer.** A working, ugly, fully-tested agent. First
   usable milestone.
7. Session persistence, resume, compaction.
8. Generated `bl` surface — hot set, then discovery meta-tools.
9. Skills layer: tiered loading, host adaptation, bilingual frontmatter.
10. Language enforcement.
11. Ink UI over the existing event stream.
12. Media rendering.
13. Script toolkit + `uv` probing.
14. MCP + Command Pack sources.
15. Redaction rewrite.
16. Docs: `FORK.md`, README, `docs/agents/agent-tui.md`.

Steps 1–6 deliver a working agent. Everything after is capability and polish.

---

## 15. Risks

| Risk                                         | Mitigation                                            |
| -------------------------------------------- | ----------------------------------------------------- |
| Ink adds React to the CLI (~1.3–1.5 MB)      | Accepted. Noise against a 410 MB dev tree.            |
| Upstream `FlagsDef` changes break generation | Golden tests surface it as a diff                     |
| Upstream skill rewrites break adaptation     | Preamble overrides rather than edits; packs untouched |
| `uv` absent on user machines                 | Tools do not register; model falls back to code       |
| Windows shell differences                    | Explicit interpreter selection; probed at startup     |
| Scope                                        | Staged; step 6 is independently shippable             |

---

## 16. Open questions

None blocking. Resolved during design: scope (full TUI), tool strategy
(hybrid), permission posture (three-tier), Chinese-for-tokens (rejected —
near parity, localize for UX), `uv` scripts (yes, optional), vault (rewritten,
input-only, opt-in), skill frontmatter (bilingual), project identity
(**Kuang 匡**, §12.1).

Deferred, not blocking:

- Renaming internal libraries — only if published to a registry.
- `bl memory` integration for cross-session memory (§10) — optional, after
  step 7.
- Upstreaming the bilingual skill frontmatter (§6.3) to `modelstudioai/cli`.
