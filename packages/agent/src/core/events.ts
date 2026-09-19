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
  /**
   * A file the agent changed, diffed against its previous state.
   *
   * The previous state is the file's content at first touch for a first edit,
   * and the previous successful write afterwards — so each entry answers
   * "what did that edit do?", the way the approval box does.
   *
   * Emitted only after the tool reports success, so the panel never shows a
   * change that did not happen. Each emission for a path supersedes the last:
   * the feed is the sequence, the folded view is the latest per path.
   */
  | { type: "file_changed"; path: string; diff: string; added: number; removed: number }
  /** Values withheld from this request, counted by rule id. Never the values. */
  | { type: "redacted"; counts: Record<string, number> }
  | { type: "turn_end"; usage: Usage }
  | { type: "error"; message: string };

export type EventSink = (event: AgentEvent) => void;

/** A recording sink. The test renderer, and the reference EventSink consumer. */
export function collect(): { sink: EventSink; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return { sink: (e) => void events.push(e), events };
}
