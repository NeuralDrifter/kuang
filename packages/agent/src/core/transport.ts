// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapts DashScope's OpenAI-compatible streaming chat endpoint to the loop's
 * `Transport` shape.
 *
 * `chunksFromSSE` is kept separate from the network client so the SSE
 * framing (text deltas, tool-call delta reassembly by index, `[DONE]`,
 * malformed JSON) can be tested without a socket. `dashscopeTransport` is
 * the thin wrapper that actually posts to the chat endpoint and streams the
 * response through it.
 */
import { chatPath, parseSSE, type Client } from "bailian-cli-core";
import type { Transport, StreamChunk } from "./loop.ts";

interface StreamDeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string } | null;
}

interface StreamChoice {
  delta?: {
    content?: string | null;
    tool_calls?: (StreamDeltaToolCall | null)[] | null;
  } | null;
}

interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface StreamPayload {
  choices?: (StreamChoice | null)[] | null;
  /**
   * DashScope sends `usage: null` on every intermediate delta frame once
   * `stream_options.include_usage` is set, and populates it only on the
   * final, choice-less frame. Typed nullable so every read site has to
   * account for that rather than dereferencing a frame that hasn't arrived
   * yet — `payload.usage !== undefined` let a `null` frame straight through
   * and crashed the stream on the very first delta of every live turn.
   */
  usage?: StreamUsage | null;
}

/**
 * Turn raw SSE `data:` payloads into `StreamChunk`s. Stops at `[DONE]`;
 * silently skips a payload that isn't valid JSON rather than ending the
 * stream over one bad chunk. Every field read off a parsed payload is
 * guarded for truthiness (not `!== undefined`) because DashScope sends
 * explicit `null` — not just omission — for fields that haven't arrived yet
 * on a given frame.
 */
export async function* chunksFromSSE(
  events: AsyncIterable<{ data: string }>,
): AsyncIterable<StreamChunk> {
  for await (const event of events) {
    if (event.data === "[DONE]") return;

    let payload: StreamPayload;
    try {
      payload = JSON.parse(event.data) as StreamPayload;
    } catch {
      continue;
    }

    for (const choice of payload.choices ?? []) {
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { text: delta.content };
      }

      for (const toolCall of delta.tool_calls ?? []) {
        if (!toolCall) continue;
        yield {
          toolCall: {
            index: toolCall.index,
            // `?? undefined` so a null from the wire never reaches the loop as
            // a value: the API sends `arguments: null` on trailing frames.
            id: toolCall.id ?? undefined,
            name: toolCall.function?.name ?? undefined,
            argumentsDelta: toolCall.function?.arguments ?? undefined,
          },
        };
      }
    }

    if (payload.usage) {
      yield {
        usage: {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
        },
      };
    }
  }
}

/** A `Transport` that streams DashScope's OpenAI-compatible chat completions. */
export function dashscopeTransport(client: Client): Transport {
  return (body: unknown) => {
    async function* run(): AsyncIterable<StreamChunk> {
      // `include_usage` makes the API emit a final usage-only frame (empty
      // `choices`) that `chunksFromSSE` turns into a `usage` chunk; without it
      // the stream never reports token counts at all.
      const requestBody = {
        ...(body as Record<string, unknown>),
        stream_options: { include_usage: true },
      };
      const response = await client.request({
        path: chatPath(),
        method: "POST",
        body: requestBody,
        stream: true,
      });
      yield* chunksFromSSE(parseSSE(response));
    }
    return run();
  };
}
