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
import { loadApprovals, saveApprovals } from "./core/approvals-file.ts";
import { createMessageReader } from "./core/input.ts";
import type { ApprovalDecision } from "./core/approvals.ts";
import type { EventSink } from "./core/events.ts";
import { runTurn } from "./core/loop.ts";
import type { ApprovalAsker } from "./core/loop.ts";
import type { AgentMessage } from "./core/messages.ts";
import type { PlatformAccess } from "./core/platform.ts";
import { Vault } from "./core/redact/vault.ts";
import { handleSlash } from "./core/slash.ts";
import { bailianTools } from "./core/tools/bailian.ts";
import { fsTools } from "./core/tools/fs.ts";
import { mediaTools } from "./core/tools/media.ts";
import { ToolRegistry } from "./core/tools/registry.ts";
import { probeInterpreters, shellTool, type Interpreter } from "./core/tools/shell.ts";
import { dashscopeTransport } from "./core/transport.ts";
import { plainRenderer } from "./ui/plain.ts";
import { localize } from "./core/i18n.ts";

export type { CommandInvoker, InvokeResult, PlatformAccess } from "./core/platform.ts";
export { buildArgv } from "./core/tools/bailian.ts";

/** Used only when the user has not configured a default text model. */
const FALLBACK_MODEL = "qwen-max";

const SYSTEM_PROMPT: LocalizedText = {
  "en-US":
    "You are Kuang, an interactive coding agent running in the user's terminal. " +
    "You have tools to read, search, write and edit files in the current project, " +
    "and to run shell commands. Prefer using your tools over asking the user to " +
    "perform actions manually. Always reply in English.\n\n" +
    "Text of the form [REDACTED_CARD_1] is a secret or piece of personal data that " +
    "has been withheld from you. Copy it through unchanged — into your replies and " +
    "into tool arguments — and the real value is put back before the user sees it or " +
    "a tool acts on it. You cannot read what is inside one, so if a task genuinely " +
    "needs the contents, say so instead of guessing. Never invent a placeholder of " +
    "your own; one that was never issued is printed literally.",
  "zh-CN":
    "你是匡，一个运行在用户终端中的交互式编程 Agent。你拥有读取、搜索、写入和编辑" +
    "当前项目文件，以及运行 shell 命令的工具。请优先使用工具，而不是要求用户手动操作。" +
    "请始终使用中文回复。\n\n" +
    "形如 [REDACTED_CARD_1] 的文本表示一项已对你隐藏的密钥或个人数据。请原样传递它——" +
    "无论是写入回复还是写入工具参数——真实值会在用户看到之前、或工具执行之前被还原。" +
    "你无法读取其中的内容，因此若某项任务确实需要真实内容，请直接说明，而不要猜测。" +
    "切勿自行编造占位符；未曾签发的占位符会被原样输出。",
};

export interface AgentOptions {
  /**
   * Start with redaction on. Off by default because it is best-effort: a false
   * positive costs nothing visible, but a user who believes it is complete and
   * is wrong has been misled, so switching it on should be a decision.
   */
  redact?: boolean;
}

/** Everything the loop needs, assembled once before it starts. */
interface Session {
  tools: ToolRegistry;
  approvals: ApprovalStore;
  vault: Vault;
  transport: ReturnType<typeof dashscopeTransport>;
  sink: EventSink;
  model: string;
  language: Language;
}

/** Every tool this agent can reach. Local always; platform only when supplied. */
function buildTools(
  cwd: string,
  language: Language,
  interpreters: Interpreter[],
  platform?: PlatformAccess,
): ToolRegistry {
  const tools = new ToolRegistry();
  for (const tool of fsTools(cwd)) tools.register(tool);
  tools.register(shellTool(cwd, interpreters));
  if (platform) {
    for (const tool of mediaTools(platform, language)) tools.register(tool);
    for (const tool of bailianTools(platform, language)) tools.register(tool);
  }
  return tools;
}

/**
 * Approvals for this project, saved as answers are given rather than at exit,
 * since the usual way a session ends is not cleanly.
 *
 * Rules are scoped to `cwd`: an answer given here must not apply in some other
 * repository. A failed write is swallowed — a read-only or full disk must not
 * break the turn in progress, and the rule still holds for the rest of this
 * session, which is where things stood before persistence existed.
 */
function buildApprovals(cwd: string): ApprovalStore {
  return new ApprovalStore(loadApprovals(cwd), (rules) => {
    try {
      saveApprovals(cwd, rules);
    } catch {
      /* see above */
    }
  });
}

/** Wire the pieces together. Construction only: nothing here runs a turn. */
async function buildSession(
  ctx: CommandContext,
  cwd: string,
  platform?: PlatformAccess,
  options: AgentOptions = {},
): Promise<Session> {
  const language = ctx.settings.language;
  return {
    tools: buildTools(cwd, language, await probeInterpreters(), platform),
    approvals: buildApprovals(cwd),
    // Always present so `/pii on` works mid-session, whatever it started as.
    vault: new Vault(options.redact ?? false),
    transport: dashscopeTransport(ctx.client),
    sink: plainRenderer((s) => process.stdout.write(s), language),
    model: ctx.settings.defaultTextModel ?? FALLBACK_MODEL,
    language,
  };
}

/** Read a line of input, showing `prompt` first, or undefined at end of input. */
type ReadLine = (prompt: string) => Promise<string | undefined>;

function buildAsk(readLine: ReadLine): ApprovalAsker {
  return async (): Promise<ApprovalDecision> => {
    const answer = (await readLine("[y]es / [n]o / [a]lways: "))?.trim().toLowerCase();
    if (answer === "a") return "allow_always";
    if (answer === "y") return "allow";
    return "deny";
  };
}

/**
 * One exchange: the user's message, the turn it drives, and the transcript it
 * leaves behind.
 *
 * `runTurn` returns the transcript as far as it got, even on failure. If the
 * turn never produced anything — a transport error on the very first
 * round-trip — the user's message is still the last entry; drop it so the next
 * turn does not send two consecutive `user` messages, which some APIs reject.
 */
async function takeTurn(
  messages: AgentMessage[],
  input: string,
  session: Session,
  ask: ApprovalAsker,
): Promise<AgentMessage[]> {
  const userMessage: AgentMessage = { role: "user", content: input };
  const next = await runTurn([...messages, userMessage], { ...session, ask });
  return next.at(-1) === userMessage ? next.slice(0, -1) : next;
}

/**
 * Read, dispatch, repeat, until the user leaves or input ends.
 *
 * Slash commands are resolved before anything reaches the model, so a mistyped
 * one costs nothing.
 */
async function repl(
  session: Session,
  readLine: ReadLine,
  write: (s: string) => void,
): Promise<void> {
  const ask = buildAsk(readLine);
  let messages: AgentMessage[] = [
    { role: "system", content: localize(SYSTEM_PROMPT, session.language) },
  ];

  for (;;) {
    const raw = await readLine("> ");
    if (raw === undefined) return; // End of input: leave cleanly, like /exit.

    const input = raw.trim();
    if (input === "") continue;

    const slash = handleSlash(input, { language: session.language, vault: session.vault });
    if (slash.kind === "exit") return;
    if (slash.kind === "handled") {
      write(slash.text + "\n");
      continue;
    }

    messages = await takeTurn(messages, input, session, ask);
  }
}

/**
 * Run the interactive agent until the user leaves.
 *
 * `platform` is optional: without it the agent has local tools only. The
 * launcher supplies it, because the command map and the ability to re-invoke
 * the CLI both live on the product side — this package cannot reach either
 * without importing `commands`, which depends on it.
 */
export async function runAgent(
  ctx: CommandContext,
  platform?: PlatformAccess,
  options: AgentOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const session = await buildSession(ctx, cwd, platform, options);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /**
   * Not `rl.question`: that resolves with one line and discards anything else
   * that arrived in the same chunk, so a pasted stack trace reached the model
   * as its first line alone. The reader listens continuously and joins lines
   * that arrive together into one message — see `core/input.ts`.
   *
   * The prompt is written here rather than passed to readline, because one
   * prompt belongs to one message, not to each line of a paste.
   */
  const nextMessage = createMessageReader(rl);
  const readLine: ReadLine = async (prompt) => {
    process.stdout.write(prompt);
    return nextMessage();
  };

  try {
    await repl(session, readLine, (s) => process.stdout.write(s));
  } finally {
    rl.close();
  }
}
