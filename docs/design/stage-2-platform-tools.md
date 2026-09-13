# Stage 2 — Platform tools

**Goal:** the agent can reach the platform. Ask it for an image, a video, a
transcription or a knowledge lookup and it performs one, instead of only
reading and writing files.

**Status:** complete. All seven tasks done; the agent reaches the platform and
media request construction is verified with `--dry-run`. Live media responses
remain untested pending credits. See
[agent-architecture.md](agent-architecture.md) for the overall design.

---

## Constraint that shapes this stage

**Media generation credits are exhausted and do not renew.** Image, video and
speech generation cannot be verified against the live API until credits are
purchased. Text models are plentiful.

This does not block the work. `--dry-run` on any command prints the fully
constructed request and performs no API call:

```console
$ kuang image generate --prompt "a cat on mars" --dry-run
request:
  model: qwen-image-3.0
  input:
    messages:
      - role: user
        content:
          - text: a cat on mars
  parameters:
    size: 2048*2048
    n: 1
    prompt_extend: true
    watermark: true
mode: sync
path: /api/v1/services/aigc/multimodal-generation/generation
```

So the entire path — agent → tool schema → argument construction → CLI
invocation → request body — is verifiable for free. Only the handling of a
_live media response_ stays unverified.

**Be honest about that in the README.** Media tools ship marked as wired but
not live-tested. Do not claim otherwise.

---

## Architecture

### How the agent invokes a platform command

**Subprocess, with the invoker injected.** Two facts force this:

1. `Command.run` returns `Promise<void>` and commands write results straight to
   `process.stdout` via `emitResult`. Capturing that in-process means
   monkey-patching `process.stdout.write` while the agent is _also_ writing to
   stdout — racy, and it would swallow the agent's own output.
2. `packages/commands` depends on `kuang-agent`. The agent therefore **cannot**
   import `commands` — that is a dependency cycle. It must not try.

So `packages/commands/src/commands/agent/index.ts` (which is inside `commands`
and may see everything) passes two things down:

```ts
export interface PlatformAccess {
  /** The product command map, for building tool schemas from `flags`. */
  commands: Record<string, AnyCommand>;
  /** Runs one CLI command out-of-process and returns its result. */
  invoke: CommandInvoker;
}

export type CommandInvoker = (
  argv: string[],
  opts?: { dryRun?: boolean; timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
```

`runAgent(ctx, platform?)` takes it optionally, so the agent still runs with
local tools alone if it is omitted. `AnyCommand` comes from `bailian-cli-core`,
which the agent already depends on — no new edge, no cycle.

The launcher implements `invoke` with `execFile(process.execPath, [entry, ...argv])`
plus `--output json`. Always argv arrays, never a shell string.

### Tool surface: hot set + discovery

228 commands cannot all be tool schemas — that is roughly 60k tokens of context
on every turn. Two tiers:

**Hot set** — promoted to first-class tools with tuned descriptions, because
they are what the agent is actually for:

| Tool                 | Command              |
| -------------------- | -------------------- |
| `generate_image`     | `image generate`     |
| `generate_video`     | `video generate`     |
| `text_to_speech`     | `speech synthesize`  |
| `transcribe_audio`   | `speech recognize`   |
| `describe_image`     | `vision describe`    |
| `search_web`         | `search web`         |
| `retrieve_knowledge` | `knowledge retrieve` |

All seven paths verified present in `packages/cli/src/commands.ts` as of
2026-09-13. Re-check if upstream is merged since.

**Discovery** — everything else, reached through three meta-tools:

- `bl_search_commands(query)` — substring/keyword match over command paths and
  descriptions, returns paths + one-line descriptions
- `bl_describe_command(path)` — full generated schema for one command
- `bl_run_command(path, flags)` — runs any command not in the hot set

Resident cost: roughly 2.5k tokens, versus 60k for the naive approach.

### The generator

`FlagsDef` → JSON Schema, mechanically. This is the reason this stage is cheap:

```ts
// packages/core/src/types/command.ts
interface ValueFlag {
  type: "string" | "number" | "boolean" | "array";
  description: LocalizedText; // already { "en-US", "zh-CN" }
  valueHint: string;
  required?: boolean;
  choices?: readonly string[];
}
```

Maps directly: `type` → `type`, `choices` → `enum`, `required` → `required[]`,
`description[language]` → `description`. Bilingual for free, and structurally
incapable of drifting from the CLI because it _is_ the CLI's own metadata.

`switch` flags become `{ type: "boolean" }`. `array` becomes
`{ type: "array", items: { type: "string" } }`.

Global flags (`--output`, `--timeout`, `--quiet`, …) are **excluded** from
generated schemas — the agent sets those itself. `GLOBAL_FLAGS` in
`packages/core/src/types/command.ts` is the list to exclude.

### Approval tiers

Anything that spends money or writes is `ask`. Specifically:

- `ask`: `generate_image`, `generate_video`, `text_to_speech`, and any
  `bl_run_command` whose command has `risk` set or whose path starts with a
  mutating verb (`create`, `delete`, `deploy`, `apply`, `destroy`, `update`)
- `auto`: `describe_image`, `search_web`, `retrieve_knowledge`,
  `bl_search_commands`, `bl_describe_command`, and read-only `bl_run_command`
  paths (`list`, `get`, `status`, `search`)

**The preview must state that the call spends credits** for the generation
tools. A user approving `generate_video` should see that it costs money before
they answer, not after.

---

## Tasks

Each ends green: `npx vp check --fix` reports 0 errors and
`cd packages/agent && npx vp test --run` passes.

### Task 1 — `core/tools/generate.ts`

Pure, no I/O. `flagsToJsonSchema(flags: FlagsDef, language: Language)` →
`{ type: "object", properties, required }`.

Tests: each flag type; `choices` → `enum`; `required` collection; both
languages resolve; global flags excluded; a real command from the map produces
a sane schema.

### Task 2 — `core/platform.ts`

The `PlatformAccess` / `CommandInvoker` types above, plus
`commandCatalog(commands)` producing `{ path, description, flags }[]` for
search and describe.

Tests: catalog covers every command in a fixture map; search matches on both
path and description; describe returns a schema.

### Task 3 — discovery meta-tools

`bl_search_commands`, `bl_describe_command`, `bl_run_command` as `Tool`s.

`bl_run_command` builds argv from `{ path, flags }` — split the path on spaces,
append `--flag value` pairs, `--switch` alone for switches, always an argv
array. Add `--output json`. Parse stdout as JSON; on parse failure return the
raw text rather than throwing.

Tests: argv construction for every flag type; a flag value containing spaces or
quotes stays one argv element; unknown command path refused; invoker failure
surfaces as a tool result, not an exception. **Use a mock invoker** — no
subprocess in tests.

### Task 4 — hot-set tools

Seven tools wrapping specific commands, with hand-written bilingual
descriptions better than the generated ones. Each declares its approval tier
per the table above; generation tools state the credit cost in their preview.

Media tools return the local output path. The CLI already writes files and
honours `--output-dir`; do not reimplement that.

Tests: argv construction per tool against a mock invoker; tier assertions;
preview text mentions cost for the three that spend.

### Task 5 — wire into the launcher

`packages/commands/src/commands/agent/index.ts` builds `PlatformAccess` from
its own command map and an `execFile`-based invoker, passes it to `runAgent`.
`runAgent` registers the platform tools when it is present.

Remember: this file is inherited from upstream and already carries the
Apache-2.0 §4(b) modification notice. Keep it.

Verification, all free:

```bash
cd packages/cli
npx tsx src/main.ts agent
> use bl_search_commands to find how to list my usage
> what flags does image generate take?
```

Then one real end-to-end through a text command (cheap):

```
> run kuang usage and tell me what it says
```

### Task 6 — dry-run verification of the media path

Add a test (or a documented manual check) that drives `generate_image` through
the real invoker with `dryRun: true` and asserts the printed request contains
the prompt. This is the closest we get to end-to-end for media until credits
exist, and it costs nothing.

### Task 7 — README honesty

Move image/video/speech from "Not yet" to "Wired, not yet verified against the
live API — credits exhausted". Do not imply they are tested. Update both
`README.md` and `README.zh.md`.

---

## Out of scope for this stage

- Skills as a knowledge layer (Stage 3)
- Session persistence and `--resume` (Stage 3)
- Ink TUI and inline media rendering (Stage 4)
- The two security items in [agent-architecture.md](agent-architecture.md) §9
  and the README's Security section: the shell-command denylist (**must land
  with approvals persistence, not after**) and `realpath` containment

## Picking this up cold

Read [agent-architecture.md](agent-architecture.md) §4–§5 first for the core
design, then this file. The existing agent lives in `packages/agent/src`:
`core/` is pure and must never import `ui/`. Conventions are in
[AGENTS.md](AGENTS.md).

Local constraints that will bite you otherwise:

- Every new `.ts` file needs the Apache-2.0 header or the pre-commit hook
  rejects the commit
- Relative imports carry an explicit `.ts` extension
- Unused imports and variables are lint **errors**
- No `process.exit()` outside `tools/**` and tests
- Never `--no-verify`
- The hook regenerates `skills/*/reference/*.md`; run `git restore skills/`
  afterwards and never commit them
- Do not run the bare root test suite — it includes e2e and hangs. Run
  per-package with an explicit file.
