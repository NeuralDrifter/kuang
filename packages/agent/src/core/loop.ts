// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The turn loop: the heart of the agent.
 *
 * One model round-trip produces exactly one assistant message —
 * `assistantMessage(text, toolCalls)` is built and pushed once per round,
 * never once for text and again for tool calls. When a round produced tool
 * calls, each is resolved through the approval flow (spec §7) and the loop
 * runs again so the model sees the results; a text-only round ends the turn.
 *
 * The whole body is wrapped so a transport failure becomes an `error` event
 * rather than an exception — a single bad request must never end the
 * session — and the round count is capped so a model that keeps calling
 * tools cannot spend without bound.
 */
import type { Language } from "bailian-cli-core";
import { assistantMessage, toWireMessages, type AgentMessage, type ToolCall } from "./messages.ts";
import type { EventSink, ToolPreview, Usage } from "./events.ts";
import type { Tool, ToolRegistry } from "./tools/registry.ts";
import type { ApprovalDecision, ApprovalStore } from "./approvals.ts";

export interface StreamChunk {
  text?: string;
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  usage?: Usage;
}

export type Transport = (body: unknown) => AsyncIterable<StreamChunk>;

export type ApprovalAsker = (call: ToolCall, preview: ToolPreview) => Promise<ApprovalDecision>;

export interface LoopOptions {
  transport: Transport;
  tools: ToolRegistry;
  approvals: ApprovalStore;
  ask: ApprovalAsker;
  sink: EventSink;
  model: string;
  language: Language;
  maxIterations?: number;
}

/** In-progress accumulation of one tool call's streamed deltas. */
interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A default preview for tools that don't define one. */
function defaultPreview(call: ToolCall): ToolPreview {
  return { summary: `${call.name}(${call.arguments})` };
}

/**
 * Resolve the preview to show the user before asking for approval. A
 * `preview()` that throws must not escape: that would end the whole turn
 * before consent is even requested (e.g. `edit_file` diffing against a file
 * deleted meanwhile). Fall back to the default summary instead.
 */
async function previewFor(
  tool: Tool,
  call: ToolCall,
  args: Record<string, unknown>,
): Promise<ToolPreview> {
  if (!tool.preview) return defaultPreview(call);
  try {
    return await tool.preview(args);
  } catch {
    return defaultPreview(call);
  }
}

/**
 * Run one accumulated round-trip's worth of streamed chunks, buffering
 * `text_delta` events as chunks arrive; `tool_call` events are emitted only
 * once the stream fully drains, since a call's id/name/arguments can keep
 * accumulating across deltas until then. Returns the full text and the
 * resolved tool calls for the round.
 */
async function consumeStream(
  stream: AsyncIterable<StreamChunk>,
  sink: EventSink,
): Promise<{ text: string; toolCalls: ToolCall[]; usage: Usage }> {
  let text = "";
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const pending = new Map<number, PendingToolCall>();
  const order: number[] = [];

  for await (const chunk of stream) {
    if (chunk.text !== undefined) {
      text += chunk.text;
      sink({ type: "text_delta", text: chunk.text });
    }
    if (chunk.toolCall !== undefined) {
      const delta = chunk.toolCall;
      let entry = pending.get(delta.index);
      if (!entry) {
        entry = { id: delta.id ?? "", name: delta.name ?? "", arguments: "" };
        pending.set(delta.index, entry);
        order.push(delta.index);
      }
      // Guard for null, not just undefined: the API sends `arguments: null`
      // on trailing tool-call frames, and `+= null` appends the text "null",
      // corrupting the JSON the model carefully built. A null `name` would
      // likewise clobber a good one.
      if (delta.id != null) entry.id = delta.id;
      if (delta.name != null) entry.name = delta.name;
      if (delta.argumentsDelta != null) entry.arguments += delta.argumentsDelta;
    }
    if (chunk.usage !== undefined) usage = chunk.usage;
  }

  const toolCalls: ToolCall[] = order.map((index) => {
    const entry = pending.get(index)!;
    return { id: entry.id, name: entry.name, arguments: entry.arguments };
  });

  for (const call of toolCalls) {
    sink({ type: "tool_call", call });
  }

  return { text, toolCalls, usage };
}

/**
 * Run one tool call through the approval flow, returning the tool message to
 * push. Every path emits exactly one `tool_result` for this call's `id` —
 * including the paths where the tool never runs (`never`, denied, unknown
 * name, unparsable arguments) — so a renderer keying a per-call row off
 * `callId` never has one stuck pending.
 */
async function resolveCall(call: ToolCall, options: LoopOptions): Promise<AgentMessage> {
  const { tools, approvals, ask, sink } = options;

  const refuse = (reason: string, content: string): AgentMessage => {
    sink({ type: "tool_result", callId: call.id, ok: false, summary: reason });
    return { role: "tool", toolCallId: call.id, content };
  };

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary =
      options.language === "zh-CN"
        ? `无效的 JSON 参数: ${message}`
        : `Invalid JSON arguments: ${message}`;
    return refuse(summary, `Could not parse arguments as JSON: ${message}`);
  }

  const tool = tools.get(call.name);
  if (!tool) {
    const summary =
      options.language === "zh-CN" ? `未知工具: ${call.name}` : `Unknown tool: ${call.name}`;
    return refuse(summary, `Unknown tool: ${call.name}`);
  }

  const runAndReport = async (): Promise<AgentMessage> => {
    try {
      const result = await tool.run(args);
      sink({ type: "tool_result", callId: call.id, ok: true, summary: result });
      return { role: "tool", toolCallId: call.id, content: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink({ type: "tool_result", callId: call.id, ok: false, summary: message });
      return { role: "tool", toolCallId: call.id, content: `Tool failed: ${message}` };
    }
  };

  if (tool.tier === "never") {
    const summary = options.language === "zh-CN" ? "不允许使用" : "Not permitted";
    return refuse(summary, "This tool is not permitted.");
  }

  if (tool.tier === "auto") {
    return runAndReport();
  }

  // tool.tier === "ask"
  if (approvals.isAllowed(call.name, args)) {
    return runAndReport();
  }

  const preview = await previewFor(tool, call, args);
  sink({ type: "tool_approval_required", call, preview });

  let decision: ApprovalDecision;
  try {
    decision = await ask(call, preview);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary =
      options.language === "zh-CN"
        ? `授权提示失败: ${message}`
        : `Approval prompt failed: ${message}`;
    return refuse(summary, `Approval prompt failed: ${message}`);
  }

  if (decision === "deny") {
    const summary = options.language === "zh-CN" ? "用户拒绝" : "Denied by the user";
    return refuse(summary, "Denied by the user.");
  }
  if (decision === "allow_always") {
    approvals.allowAlways(call.name, args);
  }
  return runAndReport();
}

/**
 * Run turns until the model stops calling tools, the iteration cap is hit,
 * or the transport throws. Returns the transcript, including whatever was
 * appended before any failure.
 */
export async function runTurn(
  messages: AgentMessage[],
  options: LoopOptions,
): Promise<AgentMessage[]> {
  const { transport, tools, sink, model, language } = options;
  const maxIterations = options.maxIterations ?? 25;
  const transcript = [...messages];

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      sink({ type: "turn_start" });

      const body = {
        model,
        messages: toWireMessages(transcript),
        tools: tools.schemas(language),
        stream: true,
      };

      const { text, toolCalls, usage } = await consumeStream(transport(body), sink);
      transcript.push(assistantMessage(text, toolCalls));

      for (const call of toolCalls) {
        const toolMessage = await resolveCall(call, options);
        transcript.push(toolMessage);
      }

      sink({ type: "turn_end", usage });

      if (toolCalls.length === 0) {
        return transcript;
      }
    }

    sink({ type: "error", message: `Exceeded maximum iterations (${maxIterations}).` });
    return transcript;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink({ type: "error", message });
    return transcript;
  }
}
