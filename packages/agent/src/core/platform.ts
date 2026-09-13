// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Access to the platform's own command surface.
 *
 * The agent cannot import the command library: `packages/commands` depends on
 * this package, so the reverse would be a cycle. Instead the launcher — which
 * lives inside `commands` and can see everything — passes a `PlatformAccess`
 * down. That also keeps execution out-of-process, which matters because
 * commands return `void` and write their results straight to stdout; capturing
 * that in-process would mean intercepting the same stream the agent writes to.
 */
import type { AnyCommand, AuthRequirement, Language } from "bailian-cli-core";
import { localize } from "./i18n.ts";
import { flagsToJsonSchema, type JsonSchemaObject } from "./tools/generate.ts";

/** What one out-of-process command run produced. */
export interface InvokeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs one CLI command. Always an argv array — never a shell string, so a
 * model-supplied flag value cannot become shell syntax.
 */
export type CommandInvoker = (
  argv: string[],
  opts?: { dryRun?: boolean; timeoutMs?: number },
) => Promise<InvokeResult>;

/** Supplied by the launcher; absent when the agent runs with local tools only. */
export interface PlatformAccess {
  commands: Record<string, AnyCommand>;
  invoke: CommandInvoker;
}

/** One command, flattened for search and for schema generation. */
export interface CatalogEntry {
  /** Product path as typed, e.g. `image generate`. */
  path: string;
  description: string;
  schema: JsonSchemaObject;
  auth: AuthRequirement;
  /** The command declares a risk level upstream — never auto-approve it. */
  risky: boolean;
}

/** Flatten the product command map into searchable, callable entries. */
export function commandCatalog(
  commands: Record<string, AnyCommand>,
  language: Language,
): CatalogEntry[] {
  return Object.entries(commands).map(([path, command]) => ({
    path,
    description: localize(command.description, language),
    schema: flagsToJsonSchema(command.flags ?? {}, language),
    auth: command.auth,
    risky: command.risk !== undefined,
  }));
}

export function findCommand(catalog: CatalogEntry[], path: string): CatalogEntry | undefined {
  return catalog.find((entry) => entry.path === path);
}

/**
 * Find commands matching every term in `query`.
 *
 * AND rather than OR: with 228 commands, an OR search on a two-word query
 * returns most of the catalog and tells the model nothing. Path matches sort
 * ahead of description-only matches, since a model searching "video" wants
 * `video generate` before something that merely mentions video.
 */
export function searchCatalog(catalog: CatalogEntry[], query: string, limit = 20): CatalogEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: { entry: CatalogEntry; score: number }[] = [];
  for (const entry of catalog) {
    const path = entry.path.toLowerCase();
    const description = entry.description.toLowerCase();
    if (!terms.every((term) => path.includes(term) || description.includes(term))) continue;

    // A term at the head of the path names the command's own namespace, which
    // beats the same word appearing deeper in an unrelated one — searching
    // "video" must not surface `finetune video create` above `video generate`.
    const inPath = terms.filter((term) => path.includes(term)).length;
    const leads = terms.some((term) => path.startsWith(term)) ? 1 : 0;
    scored.push({ entry, score: inPath + leads * 10 });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((s) => s.entry);
}
