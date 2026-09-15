// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable JSON for the agent's own state: approvals, sessions.
 *
 * Two properties matter, and both are about what happens when things go wrong
 * rather than when they go right.
 *
 * **A write is atomic.** The data is written to a temporary file and renamed
 * over the target, so a crash or a full disk mid-write leaves the previous
 * contents intact. A half-written session file is worse than no session file:
 * it looks like data and is not.
 *
 * **A damaged file never stops the agent starting.** Anything unreadable or
 * unparsable is moved aside and treated as absent. Losing yesterday's
 * approvals is a nuisance; refusing to launch because of them is a failure,
 * and a tool that will not start is a tool with no way to fix itself.
 *
 * Paths are passed in rather than derived here, so the policy about *where*
 * things live stays in one place (`paths.ts`) and this stays testable against
 * a temporary directory.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Owner-only. Sessions and approvals describe a user's private work. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Move a file that could not be read out of the way, so the next run starts
 * clean without destroying whatever it was — it may be the only copy of
 * something the user wants back.
 */
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    // If even that fails there is nothing useful left to try, and failing to
    // tidy up must not be the reason the agent will not start.
  }
}

/**
 * Parse the JSON at `path`, or return `fallback` if it is missing, unreadable
 * or malformed. A malformed file is quarantined on the way past.
 */
export function readJson<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissing(err)) return fallback;
    // Unreadable for another reason — permissions, a directory in its place.
    // Leave it alone: quarantining what we cannot read risks moving something
    // that is fine and merely locked.
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    quarantine(path);
    return fallback;
  }
}

/** Write `value` as pretty JSON, atomically, creating parents as needed. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });

  // Unique per process and call: two agents writing at once must not share a
  // temp file, or one will rename the other's half-written bytes into place.
  const temp = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );

  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    renameSync(temp, path);
  } catch (err) {
    // Never leave the temp file behind to accumulate.
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}
