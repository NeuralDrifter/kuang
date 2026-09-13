// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The boundary between the agent loop and any renderer.
 *
 * `core/` must never import from `ui/`. The loop pushes events into an
 * `EventSink`; renderers subscribe. That inversion is what lets the entire
 * agent be tested headlessly — `collect()` is the test renderer.
 */
import type { ToolCall } from "./messages.ts";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** What the user is shown before approving a tool call. */
export interface ToolPreview {
  /** One-line summary, e.g. `read_file(src/a.ts)`. */
  summary: string;
  /** Unified diff for write/edit; absent for other tools. */
  diff?: string;
}

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_approval_required"; call: ToolCall; preview: ToolPreview }
  | { type: "tool_result"; callId: string; ok: boolean; summary: string }
  | { type: "turn_end"; usage: Usage }
  | { type: "error"; message: string };

export type EventSink = (event: AgentEvent) => void;

/** A recording sink. The test renderer, and the reference EventSink consumer. */
export function collect(): { sink: EventSink; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { sink: (e) => void events.push(e), events };
}
