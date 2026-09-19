// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * What each file looked like when the agent first touched it, for the session.
 *
 * The diff panel diffs a file's *current* content against this, not against
 * its previous edit: diffing edit against edit drifts, and the folded view
 * would stop meaning "everything the agent has done to this file".
 *
 * Kept deliberately beyond its immediate use. The baseline is the content a
 * revert restores to, which makes reversal a later feature rather than a
 * later rewrite — nothing reads it for that yet, and nothing should be built
 * for that yet.
 *
 * Every read here is best-effort and throws nothing. The tools report their
 * own failures through `tool_result`; this is an observer of their success,
 * and a diff-capture glitch must never become a second, different failure
 * that ends the turn.
 */
import { readFile } from "node:fs/promises";
import { resolveInProject } from "./tools/fs.ts";

export class FileBaselines {
  /** Content at first touch — what a session-level revert restores to. */
  private readonly snapshots = new Map<string, string>();
  /** Content after the previous successful write — what the next edit diffs against. */
  private readonly lastAfter = new Map<string, string>();

  constructor(private readonly root: string) {}

  /**
   * Remember the file's content at first touch, once per path.
   *
   * A missing file is an empty baseline: capture runs just before a write
   * tool runs, so "does not exist" means "is about to be created".
   */
  async capture(rel: string): Promise<void> {
    if (this.snapshots.has(rel)) return;

    let content: string | undefined;
    try {
      content = await readFile(resolveInProject(this.root, rel), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
      content = "";
    }
    this.snapshots.set(rel, content);
  }

  /**
   * The content at first touch.
   *
   * `undefined` means "no honest baseline exists" — either never touched, or
   * the first read failed — and callers must skip rather than substitute.
   * `""` means the file did not exist at first touch and was created since;
   * the two are not the same thing, and conflating them fabricates a diff
   * that shows an existing file as born empty.
   */
  baselineOf(rel: string): string | undefined {
    return this.snapshots.get(rel);
  }

  /** The file as it is now, or undefined when it cannot be read. */
  async readNow(rel: string): Promise<string | undefined> {
    try {
      return await readFile(resolveInProject(this.root, rel), "utf-8");
    } catch {
      return undefined;
    }
  }

  /** The content after the previous successful write, or undefined. */
  lastAfterOf(rel: string): string | undefined {
    return this.lastAfter.get(rel);
  }

  /**
   * Remember the content just written, so the next edit diffs against it
   * rather than against the first-touch baseline.
   */
  recordAfter(rel: string, content: string): void {
    this.lastAfter.set(rel, content);
  }
}
