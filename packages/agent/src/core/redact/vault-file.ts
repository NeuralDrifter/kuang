// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The sealed vault on disk. Opt in, or nothing here ever runs.
 *
 * The default is what it has always been: the vault lives in memory and dies
 * with the session. This exists so someone who wants a resumed conversation to
 * still show their own data can have it, at the cost of a passphrase.
 */
import { existsSync, rmSync } from "node:fs";
import { vaultPath } from "../paths.ts";
import { readJson, writeJson } from "../store.ts";
import { isSealed, seal, unseal, type SealedVault } from "./sealed.ts";
import type { Vault, VaultSnapshot } from "./vault.ts";

/** Whether this session has a sealed vault waiting to be opened. */
export function hasVault(id: string, path: string = vaultPath(id)): boolean {
  return existsSync(path);
}

/** Seal the vault's current contents under `passphrase`. */
export function saveVault(
  id: string,
  vault: Vault,
  passphrase: string,
  path: string = vaultPath(id),
): void {
  writeJson(path, seal(vault.snapshot(), passphrase));
}

/**
 * Open the sealed vault, or return undefined when there is nothing to open.
 *
 * Throws `WrongPassphraseError` when there is a file and the passphrase does
 * not fit it — the caller decides what to do, and the right answer is to carry
 * on without it rather than refuse to start.
 */
export function loadVault(
  id: string,
  passphrase: string,
  path: string = vaultPath(id),
): VaultSnapshot | undefined {
  const stored = readJson<unknown>(path, undefined);
  if (!isSealed(stored)) return undefined;
  return unseal(stored as SealedVault, passphrase);
}

/**
 * Delete the sealed vault.
 *
 * Deliberately unrecoverable: `/pii forget` means the user has decided their
 * secrets should not be on this disk, and moving the file aside the way a
 * damaged one is quarantined would defeat that.
 */
export function forgetVault(id: string, path: string = vaultPath(id)): void {
  rmSync(path, { force: true });
}
