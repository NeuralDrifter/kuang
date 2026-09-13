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
  function?: { name?: string; arguments?: string };
}

interface StreamChoice {
  delta?: {
    content?: string;
    tool_calls?: StreamDeltaToolCall[];
  };
}

interface StreamPayload {
  choices?: StreamChoice[];
}

/**
 * Turn raw SSE `data:` payloads into `StreamChunk`s. Stops at `[DONE]`;
 * silently skips a payload that isn't valid JSON rather than ending the
 * stream over one bad chunk.
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
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content !== undefined) {
        yield { text: delta.content };
      }

      for (const toolCall of delta.tool_calls ?? []) {
        yield {
          toolCall: {
            index: toolCall.index,
            id: toolCall.id,
            name: toolCall.function?.name,
            argumentsDelta: toolCall.function?.arguments,
          },
        };
      }
    }
  }
}

/** A `Transport` that streams DashScope's OpenAI-compatible chat completions. */
export function dashscopeTransport(client: Client): Transport {
  return (body: unknown) => {
    async function* run(): AsyncIterable<StreamChunk> {
      const response = await client.request({
        path: chatPath(),
        method: "POST",
        body,
        stream: true,
      });
      yield* chunksFromSSE(parseSSE(response));
    }
    return run();
  };
}
