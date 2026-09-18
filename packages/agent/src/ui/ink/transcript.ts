// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The conversation as the screen needs it, fed by the same `AgentEvent`
 * stream the plain renderer consumes.
 *
 * Kept apart from the components because what belongs on screen is a question
 * about the conversation, not about React: finished lines never change and can
 * be printed once and forgotten, while the reply still arriving must redraw on
 * every chunk. Splitting those two is the whole performance story of a long
 * session, and it is worth being able to reason about it without a renderer.
 */
import type { AgentEvent } from "../../core/events.ts";

export type EntryKind = "user" | "reply" | "tool" | "notice" | "error";

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
  /** For tool entries: whether it succeeded. Undefined while still running. */
  ok?: boolean;
}

/** One file the agent changed, diffed from its content at first touch. */
export interface FileChange {
  id: number;
  path: string;
  diff: string;
  added: number;
  removed: number;
}

export interface TranscriptState {
  /** Finished and immutable. Printed once, never redrawn. */
  done: Entry[];
  /**
   * Files the agent has changed, in the order the changes happened.
   *
   * Deliberately not folded into `done`: a diff is not a line of conversation,
   * and flattening one into text loses the structure the panel renders from.
   * The folded per-file view is the latest entry for each path.
   */
  changes: FileChange[];
  /** The reply currently streaming in, if any. */
  streaming: string;
  /** Set while a turn is in flight, so the UI can show it is busy. */
  busy: boolean;
  tokens: { prompt: number; completion: number };
}

export function emptyTranscript(): TranscriptState {
  return {
    done: [],
    changes: [],
    streaming: "",
    busy: false,
    tokens: { prompt: 0, completion: 0 },
  };
}

let nextId = 0;

function entry(kind: EntryKind, text: string, ok?: boolean): Entry {
  nextId += 1;
  return { id: nextId, kind, text, ok };
}

/**
 * Move whatever has streamed so far into the finished part.
 *
 * A model usually says what it is about to do and then does it, so the text
 * arrives before the tool call. But text lives in `streaming` until the turn
 * ends, while a tool call is finished the moment it arrives — so without this
 * the tool line jumps above the sentence introducing it, and the conversation
 * reads back to front.
 */
function settle(state: TranscriptState): TranscriptState {
  if (!state.streaming) return state;
  return {
    ...state,
    done: [...state.done, entry("reply", state.streaming)],
    streaming: "",
  };
}

/** Anything the user typed that was not a command. */
export function withUserMessage(state: TranscriptState, text: string): TranscriptState {
  return { ...state, done: [...state.done, entry("user", text)], busy: true };
}

/** Anything printed by a slash command, or by the agent about itself. */
export function withNotice(state: TranscriptState, text: string): TranscriptState {
  return { ...state, done: [...state.done, entry("notice", text)] };
}

/**
 * Fold one event into the state.
 *
 * A reply is accumulated in `streaming` and only becomes a finished entry at
 * `turn_end`, which is the point after which it can never change again.
 */
export function reduce(state: TranscriptState, event: AgentEvent): TranscriptState {
  switch (event.type) {
    case "turn_start":
      return { ...state, busy: true };

    case "text_delta":
      return { ...state, streaming: state.streaming + event.text };

    case "tool_call": {
      const settled = settle(state);
      return {
        ...settled,
        done: [...settled.done, entry("tool", `${event.call.name}(${event.call.arguments})`)],
      };
    }

    case "tool_approval_required": {
      const settled = settle(state);
      return {
        ...settled,
        done: [
          ...settled.done,
          entry(
            "notice",
            event.preview.diff
              ? `${event.preview.summary}\n${event.preview.diff}`
              : event.preview.summary,
          ),
        ],
      };
    }

    case "tool_result":
      return { ...state, done: [...state.done, entry("tool", event.summary, event.ok)] };

    case "file_changed": {
      nextId += 1;
      const change: FileChange = {
        id: nextId,
        path: event.path,
        diff: event.diff,
        added: event.added,
        removed: event.removed,
      };
      return { ...state, changes: [...state.changes, change] };
    }

    case "redacted": {
      const parts = Object.entries(event.counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, n]) => `${n} ${id}`)
        .join(", ");
      const settled = settle(state);
      return {
        ...settled,
        done: [...settled.done, entry("notice", `Withheld from the model: ${parts}`)],
      };
    }

    case "turn_end": {
      // The reply is finished, so it can move into the part that never redraws.
      const done = state.streaming ? [...state.done, entry("reply", state.streaming)] : state.done;
      return {
        ...state,
        done,
        streaming: "",
        busy: false,
        tokens: {
          prompt: state.tokens.prompt + event.usage.promptTokens,
          completion: state.tokens.completion + event.usage.completionTokens,
        },
      };
    }

    case "error":
      return { ...state, done: [...state.done, entry("error", event.message)], busy: false };

    default: {
      const exhaustive: never = event;
      throw new Error(`transcript: unhandled event ${JSON.stringify(exhaustive)}`);
    }
  }
}
