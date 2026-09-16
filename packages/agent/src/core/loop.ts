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
import { StreamRestorer } from "./redact/stream.ts";
import { sanitizeDeep } from "./redact/apply.ts";
import type { Vault } from "./redact/vault.ts";
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
  /**
   * When present, the single redaction boundary. Sensitive values are replaced
   * on the way to the model and restored on the way out — to the screen and to
   * any tool about to act on them. The transcript itself keeps real values.
   */
  vault?: Vault;
}

/**
 * Redact every string in the serialized messages.
 *
 * Walking the structure rather than stringifying the whole body keeps the JSON
 * shape intact — a placeholder is substituted for a value, never for a key or
 * a piece of syntax.
 */
function sanitizeWire(
  wire: unknown[],
  vault: Vault,
): { messages: unknown[]; counts: Record<string, number> } {
  // What the vault held before this pass. The whole transcript is re-sent on
  // every round-trip, so counting occurrences replaced would re-announce the
  // same secrets on each one; counting values newly captured names each secret
  // once, when it first appears.
  const before = vault.stats().byRule;
  const messages = sanitizeDeep(wire, vault);

  const after = vault.stats().byRule;
  const counts: Record<string, number> = {};
  for (const [id, n] of Object.entries(after)) {
    const added = n - (before[id] ?? 0);
    if (added > 0) counts[id] = added;
  }
  return { messages, counts };
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
  vault?: Vault,
): Promise<{ text: string; toolCalls: ToolCall[]; usage: Usage }> {
  const restorer = vault ? new StreamRestorer(vault) : undefined;
  let text = "";
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const pending = new Map<number, PendingToolCall>();
  const order: number[] = [];

  for await (const chunk of stream) {
    if (chunk.text !== undefined) {
      text += chunk.text;
      // Restored for display only, and through the buffering restorer so a
      // placeholder straddling two chunks is never printed half-formed.
      const shown = restorer ? restorer.push(chunk.text) : chunk.text;
      if (shown) sink({ type: "text_delta", text: shown });
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

  const tail = restorer?.flush();
  if (tail) sink({ type: "text_delta", text: tail });

  const toolCalls: ToolCall[] = order.map((index) => {
    const entry = pending.get(index)!;
    return { id: entry.id, name: entry.name, arguments: entry.arguments };
  });

  for (const call of toolCalls) {
    // Restored for display, like every other thing the user reads. The line
    // below it is an approval diff showing real values; a raw placeholder here
    // would make one call look like two different things.
    sink({
      type: "tool_call",
      call: vault ? { ...call, arguments: vault.restore(call.arguments) } : call,
    });
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
/** A refusal to run, phrased for both the renderer and the model. */
interface Refusal {
  /** One line for the user. */
  summary: string;
  /** What the model is told, which should say how to proceed. */
  content: string;
}

type Bilingual = { "en-US": string; "zh-CN": string };

function say(text: Bilingual, language: Language): string {
  return language === "zh-CN" ? text["zh-CN"] : text["en-US"];
}

/**
 * The arguments to run with, or why they cannot be used.
 *
 * Two things can go wrong before a tool is even chosen, and both are the
 * model's mistake rather than the user's, so both answer with something it can
 * act on.
 */
function argumentsFor(
  call: ToolCall,
  options: LoopOptions,
): { args: Record<string, unknown> } | { refusal: Refusal } {
  // Restore before parsing: a placeholder reaching a tool unrestored would
  // write `[REDACTED_CARD_1]` into a real file.
  const raw = options.vault ? options.vault.restore(call.arguments) : call.arguments;

  // A placeholder that survived restoration is one this vault never issued —
  // invented by the model, or inherited from a session whose vault is gone.
  const unresolved = options.vault?.unresolved(raw) ?? [];
  if (unresolved.length > 0) {
    const list = unresolved.join(", ");
    return {
      refusal: {
        summary: say(
          { "en-US": `Unresolvable placeholder: ${list}`, "zh-CN": `无法还原的占位符: ${list}` },
          options.language,
        ),
        content:
          `These placeholders were never issued in this session and cannot be ` +
          `resolved to a value: ${list}. Do not invent placeholders. If you need ` +
          `a value you cannot see, ask the user for it instead of guessing.`,
      },
    };
  }

  try {
    return { args: JSON.parse(raw) as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      refusal: {
        summary: say(
          {
            "en-US": `Invalid JSON arguments: ${message}`,
            "zh-CN": `无效的 JSON 参数: ${message}`,
          },
          options.language,
        ),
        content: `Could not parse arguments as JSON: ${message}`,
      },
    };
  }
}

/**
 * Whether this call may run: already permitted, or permitted by the user now.
 *
 * Returns a refusal rather than a boolean so the reason survives — "denied"
 * and "the prompt itself failed" are different things to tell the model.
 */
async function consentFor(
  tool: Tool,
  call: ToolCall,
  args: Record<string, unknown>,
  options: LoopOptions,
): Promise<Refusal | undefined> {
  const { approvals, ask, sink, language } = options;

  if (tool.tier === "never") {
    return {
      summary: say({ "en-US": "Not permitted", "zh-CN": "不允许使用" }, language),
      content: "This tool is not permitted.",
    };
  }
  if (tool.tier === "auto" || approvals.isAllowed(call.name, args)) return undefined;

  const preview = await previewFor(tool, call, args);
  sink({ type: "tool_approval_required", call, preview });

  let decision: ApprovalDecision;
  try {
    decision = await ask(call, preview);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: say(
        {
          "en-US": `Approval prompt failed: ${message}`,
          "zh-CN": `授权提示失败: ${message}`,
        },
        language,
      ),
      content: `Approval prompt failed: ${message}`,
    };
  }

  if (decision === "deny") {
    return {
      summary: say({ "en-US": "Denied by the user", "zh-CN": "用户拒绝" }, language),
      content: "Denied by the user.",
    };
  }
  if (decision === "allow_always") approvals.allowAlways(call.name, args);
  return undefined;
}

/** Run the tool, reporting either outcome as a tool message. */
async function runTool(
  tool: Tool,
  call: ToolCall,
  args: Record<string, unknown>,
  sink: EventSink,
): Promise<AgentMessage> {
  try {
    const raw = await tool.run(args);
    // A tool that answers with nothing is indistinguishable from one that
    // failed, and a model handed silence tends to invent what it expected to
    // see. Every tool should say so itself; this is the backstop.
    const result = raw.trim() === "" ? "(the tool returned no output)" : raw;

    sink({ type: "tool_result", callId: call.id, ok: true, summary: result });
    return { role: "tool", toolCallId: call.id, content: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sink({ type: "tool_result", callId: call.id, ok: false, summary: message });
    return { role: "tool", toolCallId: call.id, content: `Tool failed: ${message}` };
  }
}

/**
 * Turn one tool call into the message that answers it.
 *
 * Every path returns a `tool` message, including every failure, so a renderer
 * keying a row off `callId` never has one stuck pending.
 */
async function resolveCall(call: ToolCall, options: LoopOptions): Promise<AgentMessage> {
  const refuse = ({ summary, content }: Refusal): AgentMessage => {
    options.sink({ type: "tool_result", callId: call.id, ok: false, summary });
    return { role: "tool", toolCallId: call.id, content };
  };

  const parsed = argumentsFor(call, options);
  if ("refusal" in parsed) return refuse(parsed.refusal);

  const tool = options.tools.get(call.name);
  if (!tool) {
    return refuse({
      summary: say(
        { "en-US": `Unknown tool: ${call.name}`, "zh-CN": `未知工具: ${call.name}` },
        options.language,
      ),
      content: `Unknown tool: ${call.name}`,
    });
  }

  const refusal = await consentFor(tool, call, parsed.args, options);
  return refusal ? refuse(refusal) : runTool(tool, call, parsed.args, options.sink);
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

      // The single inbound boundary. Everything the model can see passes
      // through toWireMessages — user text, tool results, shell output, and
      // anything a future tool returns — so one call here covers all of it.
      const wire = toWireMessages(transcript);
      const sanitized = options.vault ? sanitizeWire(wire, options.vault) : undefined;
      const outbound = sanitized?.messages ?? wire;
      // Say what was withheld — a silent filter is indistinguishable from one
      // that is not running, and the user has no other way to tell.
      if (sanitized && Object.keys(sanitized.counts).length > 0) {
        sink({ type: "redacted", counts: sanitized.counts });
      }
      const body = {
        model,
        messages: outbound,
        tools: tools.schemas(language),
        stream: true,
      };

      const { text, toolCalls, usage } = await consumeStream(transport(body), sink, options.vault);
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
