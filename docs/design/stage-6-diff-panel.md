# Stage 6 — the live diff panel

Status: **designed, not started.** Stage 5 (the Ink UI) carried the panes, the
mouse and the per-pane scrollbars; see [stage-5-tui.md](stage-5-tui.md).

| Task                                        | State                            |
| ------------------------------------------- | -------------------------------- |
| 1 — `diff` dependency and the diff module   | done (`86aaf8e3`)                |
| 2 — `affects`, baselines and `file_changed` | done (`c810ddcf`)                |
| 3 — the transcript's change list            | done (`c810ddcf`)                |
| 4 — `<FileDiff>` and the pane mode          | done (`857c4086`)                |
| 5 — the `/panes` menu                       | done (`857c4086`)                |
| 6 — plain renderer, docs, issue log         | plain renderer done (`c810ddcf`) |

---

## Why

The agent edits files faster than anyone reads tool call lines, and a tool
call line says only that `edit_file` ran. What it _did_ is invisible unless
you approved it — and the moment you answer `a` to stop being asked, even
that goes away.

This stage is the first of three that make an agent's work **observable,
auditable and reversible**: you can see what changed as it changes, go back
through it afterwards, and eventually undo it. Only the first is built here,
but the third is why the baselines outlive their immediate use (§2).

Those three are the means. The goal is that **failures are caught early and
understood quickly**, and that is the test to apply to anything built here:

- **Caught early** makes latency a requirement, not a nicety. A change is
  shown when the write lands, not when the turn ends — by which point the
  model has usually made five more edits on top of a wrong one. Batching
  `file_changed` per turn would be cheaper and would defeat the purpose.
- **Understood quickly** means legibility beats completeness. A folded
  per-file view and a `+n −m` summary are worth more than every hunk of every
  edit, because the question being answered is "is this right?" and not "what
  exactly happened?". When the two conflict, the glanceable answer wins, and
  the detail stays one scroll away rather than in the way.

## The shape of the problem

A diff needs a before and an after. The loop has neither:

- `ToolPreview.diff` exists, but `loop.ts` computes it **only when consent is
  required**. `tool.tier === "auto" || approvals.isAllowed(...)` returns before
  `previewFor` is reached, so an approved-always `edit_file` produces nothing.
- It is also computed **before** the tool runs, so it describes intent. A write
  that then fails on permissions or a non-unique match would leave a diff in
  the panel for a change that never happened.

And the diff itself is not good enough. `unifiedDiff` in `tools/fs.ts` pairs
lines by index:

```ts
for (let i = 0; i < max; i++) {
  if (a[i] === b[i]) continue;
  if (a[i] !== undefined) lines.push(`-${a[i]}`);
  if (b[i] !== undefined) lines.push(`+${b[i]}`);
}
```

Insert one line at the top and every line below it reports as changed. That is
survivable in an approval box skimmed once. It is useless in a panel that is
read, and worse once edits are folded per file, because folding diffs the
original against the current — the case with the most opportunity to drift.

## 1. The diff itself

`diff` (jsdiff) **9.0.0**, BSD-3-Clause. It ships its own types, so there is no
`@types/diff`; it is one dependency, in a package that has two real ones.

- Added to the workspace catalog, like `ink` and `react`.
- Attribution added to `NOTICE`, which BSD-3 requires.
- A new `core/diff.ts` wraps it, so jsdiff's types never reach `ui/` and the
  library can be replaced without touching anything but that file.
- `unifiedDiff` in `tools/fs.ts` is deleted and its callers point at the new
  module, so approval previews improve with no extra work.

## 2. `core` — how a change comes to exist

### `affects`

One optional member on `Tool`:

```ts
/** The project-relative path this call will modify, when it modifies one. */
affects?: (args: Record<string, unknown>) => string | undefined;
```

`write_file` and `edit_file` implement it. Nothing else does.

### `FileBaselines`

A map from path to the file's content **when the agent first touched it**,
held for the life of the session.

Bounded by files touched, not edits made: a file rewritten twenty times costs
one entry. A file the agent never touches costs nothing.

It outlives the diff it was captured for **on purpose**. The baseline is the
content a revert would restore, so keeping it is what makes reversibility a
later feature rather than a later rewrite. Nothing in this stage reads it for
that, and nothing should be built for that yet.

### The event

```ts
| { type: "file_changed"; path: string; diff: string; added: number; removed: number }
```

Emitted by the loop, after a tool that declares `affects` **succeeds**:

1. Before the call, if the path has no baseline, read and store it.
2. Run the tool.
3. On success, read the file again and diff **baseline → current**.
4. Emit.

A failed tool emits nothing, so the panel never shows a change that did not
happen. Each emission for a path supersedes the last, which is what lets one
event serve both views: the feed is the sequence of emissions, the folded view
is the latest one per path.

**Why the loop and not the tools.** Tools are pure functions of their
arguments; the loop owns the sink. Handing tools a sink would make them
untestable in isolation, and that property is what the whole `core/` split
rests on — see the header of [`events.ts`](../../packages/agent/src/core/events.ts).

## 3. `ui` — what changes

`TranscriptState` gains:

```ts
changes: FileChange[];   // { id, path, diff, added, removed }
```

Appended per event, in order. `Entry` is **untouched**: a diff is not a line of
conversation, and flattening one into text is the mistake the current code
already makes with approval diffs (`transcript.ts` folds
`summary + "\n" + diff` into a notice, losing the structure).

`paneMode: "tools" | "diff"` selects what the right pane renders. The pane
itself, its clipping, its scroll offset and its scrollbar are unchanged — the
diff view is scrollable the same way the tool log is, because it is the same
component.

`Pane` currently takes both `entries: Entry[]` and `children`. It becomes
children-only, so the left pane passes `<Line>`s and the right passes either
`<Line>`s or `<FileDiff>`s, with the same chrome around all of them.

`<FileDiff>` draws the path, a `+n −m` summary, and the hunks — green for
additions, red for removals, dim for context.

## 4. The menu

`/panes` stops toggling and opens a menu. Toggling hid the fact that the panel
could show anything else; a list makes the modes discoverable, which is the
whole point of putting them behind a command rather than a key.

```
┌ Panel ─────────────────────────┐
│ ❯ 1  Tool calls                │
│   2  Live diff                 │
│   3  Back to flow              │
└────────────────────────────────┘
  ↑↓ move · enter choose · esc cancel
```

It draws **where the approval prompt draws**. `app.tsx` already swaps the input
block between three states — `pending`, `pendingPassphrase`, the draft — and
this is a fourth. No overlay machinery, no new layout, and the ordinary keys
stand down exactly as they already do while a question is up.

Number keys work as accelerators alongside the arrows. Escape leaves the
layout as it was.

## 5. The plain renderer

`ui/plain.ts` handles `file_changed` with one more `case`: the path, the
`+n −m` summary, and the diff — the same shape it already prints for
`tool_approval_required`. It draws no panel and should not; it runs when stdin
or stdout is not a TTY, where layout would be actively wrong.

The exhaustiveness check at the bottom of its `switch` fails to compile if the
case is missing, which is the intended forcing function.

## Tasks

### Task 1 — the diff module

Add `diff` to the catalog and to `packages/agent`. Write `core/diff.ts`:
`diffFiles(before, after, path) → { diff, added, removed }`. Delete
`unifiedDiff` and repoint `tools/fs.ts`. Tests: insertion at the top of a file
does not mark everything below it changed — the case the old one failed.

### Task 2 — baselines and the event

Add `affects` to `Tool` and implement it on the two fs tools. Add
`FileBaselines`. Add `file_changed` to `AgentEvent`. Wire the loop: snapshot,
run, re-read, emit on success. Tests: a failed write emits nothing; a second
edit to the same file diffs against the original rather than the previous.

### Task 3 — the transcript

`FileChange`, `changes: FileChange[]`, and the reducer case. Tests: order is
preserved, and two edits to one file leave two entries whose latest is the
cumulative diff.

### Task 4 — rendering

`<FileDiff>`. `Pane` becomes children-only. `paneMode` in `app.tsx`. Tests via
the existing render-to-stream helper: adds and removes are distinguishable
without colour, since colour does not survive the test harness or a pipe.

### Task 5 — the menu

`pendingMenu` as the fourth input-block state, arrow and number navigation,
escape to cancel. `/panes` opens it. Tests through the fake-TTY harness in
`ink-app.test.tsx`: the menu opens, arrows move, enter selects, escape leaves
the layout alone.

### Task 6 — plain renderer, docs, issue log

The `file_changed` case in `plain.ts`. README note. `NOTICE` attribution for
jsdiff. Anything found and deferred goes in `KNOWN_ISSUES.md`.

## Out of scope

- **Word- and character-level diffing.** Line level only.
- **Side-by-side.** The panes are already half a terminal wide.
- **Staging, reverting or editing from the panel.** The baselines make this
  possible later; nothing here builds toward it beyond keeping them.
- **Syntax highlighting inside the diff.**
- **Changes the agent did not make.** A file edited in another window while the
  session runs will show that edit as the model's, because the baseline is from
  first touch and nothing re-reads it. Detecting it means comparing disk against
  last-known-after before every write. Deferred until it bites.

## Deviations from the spec as written

Implementation is the spec's authority where they disagreed; three calls
went differently than the plan's wording suggested:

- **Tasks 2 and 3 landed together.** The exhaustiveness checks in
  `transcript.ts` and `plain.ts` refuse to compile against the new event,
  so the change-list plumbing had to arrive in the same commit as the
  event itself. The spec's task boundary did not anticipate that forcing
  function.
- **The snapshot happens after consent, not before it.** A tool that is
  asked about and refused is not a touch; snapshotting first would have
  recorded baselines for files never written.
- **A write that changes nothing emits no event.** The spec says the event
  is emitted after success; an empty diff is success with no change, and
  it would draw a phantom panel entry.

## Known risk

`affects` is a **second source of truth** about which path a call touches,
alongside the tool's own reading of its arguments. If the two ever disagree,
the panel shows the wrong file and says nothing. Limiting it to two tools that
each take a single unambiguous `path` holds it together for now; it is the
seam most likely to rot, and the first place to look when the panel lies.
