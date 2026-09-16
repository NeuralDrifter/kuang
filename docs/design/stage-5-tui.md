# Stage 5 — the Ink terminal UI

Status: **in progress.** Stage 4 (persistence) is complete; see
[stage-4-persistence.md](stage-4-persistence.md).

| Task                               | State                                           |
| ---------------------------------- | ----------------------------------------------- |
| 1 — dependencies, renderer switch  | done (`27608fc`)                                |
| 2 — input under raw mode           | mostly moot; paste is free under Ink, see below |
| 3 — the transcript                 | done, including ordering (`19010a7`)            |
| 4 — approval prompts               | done (`3892e0a`)                                |
| 4b — input history and editing     | **not started** — no arrow keys, no history     |
| 5 — status line                    | done; passphrase in Ink **not started**         |
| 6 — README, screenshots, issue log | README done; screenshots not                    |

> **Approvals now work in the Ink path.** The loop asks by awaiting a promise
> and a component cannot be awaited, so `pending.ts` sits between them: the
> loop's request becomes a value the UI draws, and a keystroke resolves what
> the loop is parked on. With no UI listening the answer is `deny`, which is
> the safe direction — refusing something nobody could be asked about is
> recoverable, running it is not.

## What building it changed about this plan

**Paste is free under raw mode.** The plan expected to rebuild coalescing on
input chunks with a timing window. Ink hands a paste over as a single `input`
string, so appending it whole to the draft is the entire fix — no window, no
bracketed-paste detection. Task 2 is therefore much smaller than written.

**Ink must be ESM all the way down.** It pulls `yoga-layout`, which uses
top-level await, so any consumer or bundle that emits CJS fails at transform
time rather than at runtime. `packages/agent` is already `"type": "module"`;
the thing to watch is the published build.

**The JSX transform depends on the working directory, so the files must not.**
Which transform runs is chosen by whichever tsconfig the runner finds. Tests
run from `packages/agent`, whose config sets `jsx: react-jsx`, and got the
automatic runtime. `npx tsx src/main.ts agent` runs from `packages/cli`, whose
config says nothing about jsx, so esbuild fell back to the classic transform
and emitted `React.createElement` into files that never imported React — the
product failed on startup with "React is not defined" while every test passed.

A `@jsxRuntime automatic` pragma does **not** fix it: esbuild ignored it, which
a transform check proved rather than assumed. Importing React explicitly does,
because the file is then correct under both transforms instead of under
whichever was guessed.

**Ink renders to any writable stream.** A test has no terminal, but
`render(element, { stdout })` will draw into a captured stream, so what reaches
the screen can be asserted on rather than assumed. This is why the drawing
parts are kept free of state and input — `components.tsx` takes props and
returns elements, while `app.tsx` owns state, keys and the wiring.

**The UI is handed callbacks, not the session.** `buildInkSession` returns
`onSubmit` and `onCommand`, so the renderer cannot reach past them into the
loop. That is what kept `core/` from changing at all, and it is worth
preserving as the components grow.

## Layout

```
┌ scrollback ─────────────────────────────┐
│ finished turns, never re-rendered       │   <Static>
├ live ───────────────────────────────────┤
│ the reply streaming in                  │
│ tool calls, approval prompts            │
├ input ──────────────────────────────────┤
│ > what the user is typing               │
├ status ─────────────────────────────────┤
│ model · redaction · session · tokens    │
└─────────────────────────────────────────┘
```

Finished turns go in `<Static>`, which Ink prints once and never touches
again. Without it every keystroke re-renders the whole transcript, and a long
conversation turns the UI to treacle.

## Tasks

Each ends green: `npx vp check --fix` reports 0 errors, package tests pass.

### Task 1 — dependencies and the renderer switch

ink 7 and react 19 in `packages/agent`. `runAgent` picks the renderer from
`process.stdout.isTTY`, and the plain one keeps working unchanged.

Test: a non-TTY still renders plain text, so the scripted drivers keep working.

### Task 2 — input under raw mode

Replace readline. Port the coalescing and the interceptor, and keep
`tests/input.test.ts` passing against the new implementation.

Test: paste is one message; a slash command typed mid-turn runs immediately;
input arriving faster than the prompt is not dropped.

### Task 3 — the transcript

`<Static>` for finished turns, a live region for the streaming reply and tool
calls. Render from the same `AgentEvent` stream the plain renderer consumes.

Test: the component renders a known event sequence to expected text, with
`ink-testing-library` if it fits, otherwise by rendering to a string.

### Task 4 — input line and approval prompts

An input component with history (up/down), and the approval prompt as a
component rather than a question written into the stream. The diff needs room
to breathe.

### Task 5 — passphrase and status

Masked passphrase entry, and a status line carrying model, redaction state,
session id and token count — the things `/pii` and `/sessions` answer, made
ambient so they need not be asked.

### Task 6 — README, screenshots, issue log

---

## Out of scope

- Mouse support.
- Themes. One good default first.
- Replacing the plain renderer. It is the fallback and the test harness.
