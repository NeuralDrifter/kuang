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
    "你是匡，一个运行在用户终端中的交互式编程 Agent。你拥有读取、搜索、写入和编辑" +
    "当前项目文件，以及运行 shell 命令的工具。请优先使用工具，而不是要求用户手动操作。" +
    "请始终使用中文回复。",
};

/** Resolve a LocalizedText against the active language. */
function localize(text: LocalizedText, language: Language): string {
  return typeof text === "string" ? text : (text[language] ?? text["en-US"]);
}

/**
 * Whether `err` is `rl.question` rejecting because stdin has already ended.
 * Verified empirically on Node v24: closing the input stream and then
 * calling `question()` again rejects with a plain `Error` whose `code` is
 * `"ERR_USE_AFTER_CLOSE"` (message `"readline was closed"`) — not a `close`
 * event racing the call, and not any other code.
 */
function isEof(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ERR_USE_AFTER_CLOSE"
  );
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

  /**
   * Read one line, or `undefined` at EOF. `rl.question` rejects with
   * `ERR_USE_AFTER_CLOSE` once stdin ends — Ctrl+D at an interactive prompt,
   * or a piped input's last line — and an unhandled rejection there would
   * propagate to the CLI's generic error handler, which has no idea this is
   * a normal way to leave a REPL. EOF is treated like `/exit`, not an error.
   */
  const readLine = async (prompt: string): Promise<string | undefined> => {
    try {
      return await rl.question(prompt);
    } catch (err) {
      if (isEof(err)) return undefined;
      throw err;
    }
  };

  const ask: ApprovalAsker = async (): Promise<ApprovalDecision> => {
    const answer = (await readLine("[y]es / [n]o / [a]lways: "))?.trim().toLowerCase();
    if (answer === "a") return "allow_always";
    if (answer === "y") return "allow";
    return "deny";
  };

  let messages: AgentMessage[] = [{ role: "system", content: localize(SYSTEM_PROMPT, language) }];

  try {
    for (;;) {
      const raw = await readLine("> ");
      if (raw === undefined) return; // EOF: leave cleanly, exactly like /exit.
      const input = raw.trim();
      if (input === "/exit") return;
      if (input === "") continue;

      const userMessage: AgentMessage = { role: "user", content: input };
      messages.push(userMessage);
      messages = await runTurn(messages, {
        transport,
        tools,
        approvals,
        ask,
        sink,
        model,
        language,
      });

      // `runTurn` returns the transcript as far as it got, even on failure. If
      // the turn never produced anything — a transport error on the very first
      // round-trip — the user's message is still the last entry; drop it so
      // the next turn doesn't send two consecutive `user` messages, which some
      // APIs reject outright.
      if (messages.at(-1) === userMessage) {
        messages.pop();
      }
    }
  } finally {
    rl.close();
  }
}
