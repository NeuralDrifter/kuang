// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Sanitize every string inside a structure, leaving the structure alone.
 *
 * Walking rather than stringifying matters: the value being sanitized is
 * usually a message array whose shape the API depends on, and a round trip
 * through JSON.stringify would let a replacement inside a key or a number
 * change what the object means.
 *
 * Shared by the request boundary and by session storage so there is one
 * implementation to audit. Both need exactly this and nothing more.
 */
import type { Vault } from "./vault.ts";

export function sanitizeDeep<T>(value: T, vault: Vault): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return vault.sanitize(node).text;
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(value) as T;
}
