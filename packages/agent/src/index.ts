// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry point for the interactive agent. Wiring only: the turn loop lives in
 * `core/loop.ts` and rendering in `ui/`, and they communicate through the
 * `AgentEvent` stream so the loop can be tested without a terminal.
 */

/** Placeholder until Task 12 wires the loop to a renderer. */
export async function runAgent(): Promise<void> {
  throw new Error("runAgent is not wired yet");
}
