# Stage 5 — the Ink terminal UI

Status: **in progress.** Stage 4 (persistence) is complete; see
[stage-4-persistence.md](stage-4-persistence.md).

| Task                               | State                                         |
| ---------------------------------- | --------------------------------------------- |
| 1 — dependencies, renderer switch  | done (`27608fc`)                              |
| 2 — input under raw mode           | not started; paste turned out free, see below |
| 3 — the transcript                 | state model done and tested; components draft |
| 4 — input line, approval prompts   | **not started — and blocking, see below**     |
| 5 — passphrase and status          | status line drafted; passphrase not started   |
| 6 — README, screenshots, issue log | not started                                   |

> **The Ink path is not usable yet.** `buildInkSession` passes
> `buildAsk(async () => undefined)`, which falls through to `"deny"`, so every
> ask-tier tool — `write_file`, `edit_file`, `shell`, anything spending credits
> — is silently refused while reporting "Denied by the user". A user would
> think they had refused something they were never asked about. Task 4 is what
> closes this, and until it does the plain path is the complete one.

## What this is, and what it is not

The renderer today is plain text with no ANSI at all. It exists to prove the
`AgentEvent` stream carries enough to drive a UI, and it does. This stage
builds the real one.

**`core/` does not change.** The turn loop, events, slash commands, sessions,
approvals and redaction are all terminal-agnostic, which was the point of
keeping `core/` unable to import `ui/`. If this stage ends up editing files
under `core/`, something has gone wrong and is worth stopping to look at.

**The plain renderer stays.** Ink requires a TTY. Piping, CI, and every
scripted test used during development are not TTYs, and a tool that only works
when a human is watching is worse than one that also works in a pipe.
`process.stdout.isTTY` picks between them.

## The decision already taken

ink 7 with React 19, and the whole project raised to Node ≥ 22.12 — the floor
CI already tested against and the only one anybody here actually ran. Node 22
is on the Chinese mirrors, so this costs that half of the audience nothing.

## The hard part: input

Ink takes stdin in **raw mode**. That replaces readline outright, and with it
everything built on readline today:

| Built on readline                | Must survive as behaviour                               |
| -------------------------------- | ------------------------------------------------------- |
| `createMessageReader` coalescing | Lines arriving together are one message, so paste works |
| `intercept`                      | A slash command runs the instant it is typed, mid-turn  |
| `MutableOutput` echo suppression | A passphrase never reaches the screen or scrollback     |
| `buildAsk`                       | Approval answers read from the same stream              |

`tests/input.test.ts` is the specification for the first two. Those tests are
not deleted when readline goes; they are pointed at whatever replaces it.

Raw mode changes the shape of the problem rather than the rule. Paste arrives
as a burst of keypresses instead of lines, so "arrived together" is measured on
input chunks rather than `line` events — the 25 ms window is the same idea.
Bracketed paste, where the terminal brackets a paste in escape sequences,
is a better signal where it is available and worth using when it is.

## What building it changed about this plan

**Paste is free under raw mode.** The plan expected to rebuild coalescing on
input chunks with a timing window. Ink hands a paste over as a single `input`
string, so appending it whole to the draft is the entire fix — no window, no
bracketed-paste detection. Task 2 is therefore much smaller than written.

**Ink must be ESM all the way down.** It pulls `yoga-layout`, which uses
top-level await, so any consumer or bundle that emits CJS fails at transform
time rather than at runtime. `packages/agent` is already `"type": "module"`;
the thing to watch is the published build.

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
