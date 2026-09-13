// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The first renderer over the agent's event stream.
 *
 * Plain text, no ANSI: it exists to prove the `AgentEvent` stream carries
 * enough information to drive a UI, and to give a working agent before any
 * Ink/React work lands. A later Ink renderer owns presentation and colour;
 * this file stays simple so it is testable and safe to pipe.
 *
 * This file may import from `core/` (types and events). Nothing in `core/`
 * may import from `ui/` — that inversion is what keeps the turn loop
 * testable without a terminal.
 */
import type { Language, LocalizedText } from "bailian-cli-core";
import type { AgentEvent, EventSink } from "../core/events.ts";

/** Resolve a LocalizedText against the active language. */
function localize(text: LocalizedText, language: Language): string {
  return typeof text === "string" ? text : (text[language] ?? text["en-US"]);
}

const LABELS = {
  running: { "en-US": "Running", "zh-CN": "执行中" },
  done: { "en-US": "Done", "zh-CN": "完成" },
  failed: { "en-US": "Failed", "zh-CN": "失败" },
  approvalRequired: { "en-US": "Approval required", "zh-CN": "需要批准" },
  tokens: { "en-US": "Tokens", "zh-CN": "令牌" },
  error: { "en-US": "Error", "zh-CN": "错误" },
} satisfies Record<string, LocalizedText>;

/**
 * Build an `EventSink` that formats each `AgentEvent` as plain text and
 * hands it to `write`. Every member of `AgentEvent` is handled explicitly;
 * an exhaustiveness check below fails to compile if a new one is added
 * without a matching case here.
 */
export function plainRenderer(write: (s: string) => void, language: Language): EventSink {
  const label = (key: keyof typeof LABELS): string => localize(LABELS[key], language);

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "turn_start": {
        // Nothing to announce yet; the first text_delta or tool_call carries
        // the visible content of the turn.
        break;
      }
      case "text_delta": {
        write(event.text);
        break;
      }
      case "tool_call": {
        write(`\n${label("running")}: ${event.call.name}(${event.call.arguments})\n`);
        break;
      }
      case "tool_approval_required": {
        write(`\n${label("approvalRequired")}: ${event.preview.summary}\n`);
        if (event.preview.diff !== undefined) {
          write(`${event.preview.diff}\n`);
        }
        break;
      }
      case "tool_result": {
        const status = event.ok ? label("done") : label("failed");
        const marker = event.ok ? "✓" : "✗";
        write(`${marker} ${status}: ${event.summary}\n`);
        break;
      }
      case "turn_end": {
        const total = event.usage.promptTokens + event.usage.completionTokens;
        write(
          `\n${label("tokens")}: ${event.usage.promptTokens} + ${event.usage.completionTokens} = ${total}\n`,
        );
        break;
      }
      case "error": {
        write(`\n${label("error")}: ${event.message}\n`);
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`plainRenderer: unhandled event ${JSON.stringify(exhaustive)}`);
      }
    }
  };
}
