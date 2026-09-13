// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * One registry for every tool source. Plan 1 registers hand-written file and
 * shell tools; later plans add generated `bl` commands, bundled scripts, MCP
 * servers and Command Packs through this same interface.
 */
import type { ChatTool, Language, LocalizedText } from "bailian-cli-core";
import type { ToolPreview } from "../events.ts";

/**
 * How much consent a tool needs (spec §7).
 *  - auto:  runs silently (reads, searches)
 *  - ask:   prompts, with a preview (writes, shell, spends money)
 *  - never: refused; the model is told why
 */
export type ApprovalTier = "auto" | "ask" | "never";

export interface Tool {
  name: string;
  tier: ApprovalTier;
  description: LocalizedText;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
  /** Shown before approval. Required in practice for `ask` tools. */
  preview?(args: Record<string, unknown>): Promise<ToolPreview>;
}

/** Resolve a LocalizedText against the active language. */
function localize(text: LocalizedText, language: Language): string {
  return typeof text === "string" ? text : (text[language] ?? text["en-US"]);
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tool definitions for the chat request, in the user's language. */
  schemas(language: Language): ChatTool[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: localize(t.description, language),
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Run a tool. Throws for unknown names rather than returning an error string,
   * so a typo cannot be mistaken for a tool's own output.
   */
  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(args);
  }
}
