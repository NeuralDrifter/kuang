// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Conversations that outlive the process.
 *
 * **What gets written is the sanitized transcript**, not the live one. The
 * model has only ever seen the sanitized view, so it is complete for resuming;
 * and a session file then holds no secret as a property of what was written,
 * rather than as a promise about a permission bit.
 *
 * That guarantee is only as wide as redaction itself. With `--redact` off
 * there is no vault, nothing was ever captured, and the file holds whatever
 * the conversation held. Turning redaction on protects the session file too,
 * which is the strongest practical argument for using it.
 *
 * Saved after each turn rather than at exit. The common way to lose a session
 * is the way sessions are usually lost, which is not cleanly.
 */
import type { Language } from "bailian-cli-core";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage } from "./messages.ts";
import { sessionPath, sessionsDir } from "./paths.ts";
import { sanitizeDeep } from "./redact/apply.ts";
import type { Vault } from "./redact/vault.ts";
import { readVersioned, writeJson } from "./store.ts";

const VERSION = 1;

/** Widest a listing title may be, so a row fits an ordinary terminal. */
const TITLE_MAX = 72;

export interface SessionRecord {
  version: number;
  id: string;
  /** Which project this belongs to, so listings never mix them. */
  projectRoot: string;
  model: string;
  language: Language;
  createdAt: string;
  updatedAt: string;
  /** Sanitized when a vault is active. See the note above. */
  messages: AgentMessage[];
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  /** First words the user typed, for recognising it in a list. */
  title: string;
  turns: number;
}

/**
 * Sortable and legible: a listing is a directory read in name order, and a
 * human scanning the folder can tell when each one happened. The suffix keeps
 * two sessions started in the same second apart.
 */
export function newSessionId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The first line of the first thing the user said, trimmed to fit a list. */
function titleOf(messages: AgentMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export interface SessionMeta {
  id: string;
  projectRoot: string;
  model: string;
  language: Language;
  createdAt?: string;
}

/**
 * Build the record to persist, sanitizing the transcript on the way.
 *
 * Sanitizing here rather than at the call site is deliberate: a caller that
 * forgets would write credentials to disk, and this is the only function that
 * produces something `saveSession` will accept.
 */
export function recordFor(
  meta: SessionMeta,
  messages: AgentMessage[],
  vault?: Vault,
  now: Date = new Date(),
): SessionRecord {
  const iso = now.toISOString();
  return {
    version: VERSION,
    id: meta.id,
    projectRoot: resolve(meta.projectRoot),
    model: meta.model,
    language: meta.language,
    createdAt: meta.createdAt ?? iso,
    updatedAt: iso,
    messages: vault ? sanitizeDeep(messages, vault) : messages,
  };
}

export function saveSession(record: SessionRecord, path: string = sessionPath(record.id)): void {
  writeJson(path, record);
}

/** Load by id, or undefined when absent, damaged, or from a shape we do not know. */
export function loadSession(id: string, path: string = sessionPath(id)): SessionRecord | undefined {
  return readVersioned<SessionRecord>(
    path,
    VERSION,
    (record) => typeof record.id === "string" && Array.isArray(record.messages),
  );
}

/**
 * Sessions belonging to `projectRoot`, newest first.
 *
 * A damaged or foreign file is skipped rather than failing the listing: one
 * bad file must not hide every good one.
 */
export function listSessions(projectRoot: string, dir: string = sessionsDir()): SessionSummary[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const wanted = resolve(projectRoot);
  const out: SessionSummary[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // Read from `dir`, not from the default location: a caller that passed a
    // directory means it.
    const record = loadSession(name.slice(0, -".json".length), join(dir, name));
    if (!record || record.projectRoot !== wanted) continue;
    out.push({
      id: record.id,
      updatedAt: record.updatedAt,
      title: titleOf(record.messages),
      turns: record.messages.filter((m) => m.role === "user").length,
    });
  }

  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The most recent session for this project, if there is one. */
export function latestSession(
  projectRoot: string,
  dir: string = sessionsDir(),
): SessionSummary | undefined {
  return listSessions(projectRoot, dir)[0];
}
