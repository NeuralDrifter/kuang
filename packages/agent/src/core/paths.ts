// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the agent keeps its own state.
 *
 * Under the CLI's existing config directory rather than a new one of its own,
 * so `BAILIAN_CONFIG_DIR` relocates everything together — and so a user who
 * cleans up after the CLI does not leave the agent's files orphaned.
 */
import { getConfigDir } from "bailian-cli-core";
import { join } from "node:path";

/** `<config>/agent` — the root for everything this package persists. */
export function agentDir(): string {
  return join(getConfigDir(), "agent");
}

/** Approval rules, keyed by project root inside the file. */
export function approvalsPath(): string {
  return join(agentDir(), "approvals.json");
}

/** One file per session. */
export function sessionsDir(): string {
  return join(agentDir(), "sessions");
}

export function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}
