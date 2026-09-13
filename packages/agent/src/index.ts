// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry point for the interactive agent. Wiring only: the turn loop lives in
 * `core/loop.ts` and rendering in `ui/`, and they communicate through the
 * `AgentEvent` stream so the loop can be tested without a terminal.
 *
 * The system prompt is a `LocalizedText` selected by `ctx.settings.language`
 * (spec §8) — without this, Qwen tends to reply in Chinese to an
 * English-speaking user regardless of what they typed.
 */
import { createInterface } from "node:readline/promises";
import type { CommandContext, Language, LocalizedText } from "bailian-cli-core";
import { ApprovalStore } from "./core/approvals.ts";
import type { ApprovalDecision } from "./core/approvals.ts";
import { runTurn } from "./core/loop.ts";
import type { ApprovalAsker } from "./core/loop.ts";
import type { AgentMessage } from "./core/messages.ts";
import { fsTools } from "./core/tools/fs.ts";
import { ToolRegistry } from "./core/tools/registry.ts";
import { probeInterpreters, shellTool } from "./core/tools/shell.ts";
import { dashscopeTransport } from "./core/transport.ts";
import { plainRenderer } from "./ui/plain.ts";

/** Used only when the user has not configured a default text model. */
const FALLBACK_MODEL = "qwen-max";

const SYSTEM_PROMPT: LocalizedText = {
  "en-US":
    "You are Kuang, an interactive coding agent running in the user's terminal. " +
    "You have tools to read, search, write and edit files in the current project, " +
    "and to run shell commands. Prefer using your tools over asking the user to " +
    "perform actions manually. Always reply in English.",
  "zh-CN":
    "你是匡,一个运行在用户终端中的交互式编程 Agent。你拥有读取、搜索、写入和编辑" +
    "当前项目文件,以及运行 shell 命令的工具。请优先使用工具,而不是要求用户手动操作。" +
    "请始终使用中文回复。",
};

/** Resolve a LocalizedText against the active language. */
function localize(text: LocalizedText, language: Language): string {
  return typeof text === "string" ? text : (text[language] ?? text["en-US"]);
}

/** Run the interactive agent until the user types `/exit`. */
export async function runAgent(ctx: CommandContext): Promise<void> {
  const language = ctx.settings.language;
  const cwd = process.cwd();

  const tools = new ToolRegistry();
  for (const tool of fsTools(cwd)) tools.register(tool);
  tools.register(shellTool(cwd, await probeInterpreters()));

  // In-memory only: persistence to ~/.bailian/agent/approvals.json is Plan 2.
  const approvals = new ApprovalStore();
  const transport = dashscopeTransport(ctx.client);
  const sink = plainRenderer((s) => process.stdout.write(s), language);
  const model = ctx.settings.defaultTextModel ?? FALLBACK_MODEL;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask: ApprovalAsker = async (): Promise<ApprovalDecision> => {
    const answer = (await rl.question("[y]es / [n]o / [a]lways: ")).trim().toLowerCase();
    if (answer === "a") return "allow_always";
    if (answer === "y") return "allow";
    return "deny";
  };

  let messages: AgentMessage[] = [{ role: "system", content: localize(SYSTEM_PROMPT, language) }];

  try {
    for (;;) {
      const input = (await rl.question("> ")).trim();
      if (input === "/exit") return;
      if (input === "") continue;

      messages.push({ role: "user", content: input });
      messages = await runTurn(messages, {
        transport,
        tools,
        approvals,
        ask,
        sink,
        model,
        language,
      });
    }
  } finally {
    rl.close();
  }
}
