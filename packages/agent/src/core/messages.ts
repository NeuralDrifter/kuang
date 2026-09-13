// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Transcript types for the agent.
 *
 * `ChatMessage` in bailian-cli-core has no `tool` role and no `tool_calls`,
 * because the non-interactive commands never needed them. Rather than cast
 * through `any` at every push site — which is how the prototype came to emit
 * two assistant messages for a single turn — the agent keeps its own transcript
 * type and serialises to the wire shape in one place.
 */

/** One tool invocation requested by the model. `arguments` is raw JSON text. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string;
}
export interface AssistantMessage {
  role: "assistant";
  content: string;
  /** Empty when the turn produced prose only. */
  toolCalls: ToolCall[];
}
export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * Build the single assistant message for a turn. A turn yields exactly one,
 * whether it produced text, tool calls, or both.
 */
export function assistantMessage(content: string, toolCalls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content, toolCalls };
}

/** Serialise the transcript to the OpenAI-compatible shape the API expects. */
export function toWireMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}
