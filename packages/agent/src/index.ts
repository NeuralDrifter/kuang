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
import {
  latestSession,
  loadSession,
  newSessionId,
  recordFor,
  saveSession,
  type SessionRecord,
} from "./core/session.ts";
import { forgetVault, hasVault, loadVault, saveVault } from "./core/redact/vault-file.ts";
import { MutableOutput, passphraseAsker, type PassphraseAsker } from "./core/secret-prompt.ts";
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
  /** Resume this session id. */
  resume?: string;
  /** Resume the most recent session for this project. */
  continueLatest?: boolean;
  /**
   * Keep the vault on disk, sealed with a passphrase, so a resumed session can
   * still show values captured before the restart.
   *
   * Off by default, and that default is the point: the vault has always lived
   * in memory and died with the session, and writing secrets down should be a
   * decision someone makes rather than one they inherit.
   */
  saveSecrets?: boolean;
}

/** Everything the loop needs, assembled once before it starts. */
interface Session {
  /** Where this conversation is filed. Fixed for the life of the process. */
  id: string;
  createdAt: string;
  projectRoot: string;
  /** The transcript to begin from: a system prompt, or a resumed history. */
  opening: AgentMessage[];
  /** One line to show before the first prompt, when something is worth saying. */
  notice?: string;
  /** Set while the vault is being kept on disk; holds the passphrase to seal with. */
  secrets: { passphrase: string } | undefined;
  /** Whether this conversation came off disk rather than starting fresh. */
  resumed: boolean;
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

const RESUMED: LocalizedText = {
  "en-US": "Resumed %id (%n turns).",
  "zh-CN": "已恢复会话 %id（%n 轮）。",
};

/** Only worth saying when the resumed history actually contains placeholders. */
const RESUMED_REDACTED: LocalizedText = {
  "en-US": " Values redacted before the restart can no longer be shown.",
  "zh-CN": " 重启前脱敏的数据将无法再显示。",
};

const ASK_PASSPHRASE: LocalizedText = {
  "en-US": "Passphrase (nothing is shown as you type): ",
  "zh-CN": "口令（输入时不会显示）：",
};

const ASK_PASSPHRASE_OPEN: LocalizedText = {
  "en-US": "This session has saved values. Passphrase to unlock them (blank to skip): ",
  "zh-CN": "本会话有已保存的数据。请输入口令解锁（留空跳过）：",
};

const SECRETS_SAVED: LocalizedText = {
  "en-US": "Captured values will be kept on disk for this session, encrypted.",
  "zh-CN": "本会话捕获的数据将加密保存在磁盘上。",
};

const SECRETS_FORGOTTEN: LocalizedText = {
  "en-US": "Saved values deleted. The vault is back to memory only.",
  "zh-CN": "已删除保存的数据。数据将仅保存在内存中。",
};

const SECRETS_SKIPPED: LocalizedText = {
  "en-US": "Carrying on without them. Older placeholders will stay as they are.",
  "zh-CN": "将不使用这些数据继续。较早的占位符将保持原样。",
};

const SECRETS_WRONG: LocalizedText = {
  "en-US": "That passphrase does not fit this file.",
  "zh-CN": "口令与该文件不匹配。",
};

const SECRETS_EMPTY: LocalizedText = {
  "en-US": "Nothing saved: a passphrase is required.",
  "zh-CN": "未保存：必须提供口令。",
};

const NO_SESSION: LocalizedText = {
  "en-US": "No session to resume in this project. Starting a new one.",
  "zh-CN": "本项目没有可恢复的会话，将开始新会话。",
};

/**
 * Which stored session to reopen, if any.
 *
 * `--resume` names one; `--continue` takes the most recent for this project.
 * Neither failing is worth refusing to start over — an id that no longer
 * exists means starting fresh, with a line saying so.
 */
function sessionToResume(cwd: string, options: AgentOptions): SessionRecord | undefined {
  if (options.resume) return loadSession(options.resume);
  if (!options.continueLatest) return undefined;
  const latest = latestSession(cwd);
  return latest ? loadSession(latest.id) : undefined;
}

/**
 * What to tell the user about a resume, if anything.
 *
 * Saying how many turns came back confirms the right conversation reopened.
 * Saying that older redacted values cannot be shown is the honest part: the
 * vault died with the previous process, so those placeholders are now just
 * text — visible in the history, and refused if a tool is asked to write one.
 */
function resumeNotice(
  resumed: SessionRecord | undefined,
  options: AgentOptions,
  language: Language,
): string | undefined {
  const asked = Boolean(options.resume || options.continueLatest);
  if (!asked) return undefined;
  if (!resumed) return localize(NO_SESSION, language);

  const turns = resumed.messages.filter((m) => m.role === "user").length;
  return localize(RESUMED, language).replace("%id", resumed.id).replace("%n", String(turns));
}

/**
 * Say that older placeholders are dead, but only once it is actually true.
 *
 * Whether it is depends on what the vault holds after any saved one has been
 * unlocked, so this asks the vault rather than guessing ahead of it — an
 * earlier version printed the warning before the unlock and then showed the
 * value anyway.
 */
function deadPlaceholderNotice(session: Session, messages: AgentMessage[]): string | undefined {
  // Only a resumed conversation can have stranded anything.
  if (!session.resumed) return undefined;

  // The system prompt explains the placeholder syntax using a literal example,
  // so it contains one by construction and would trigger this on every start.
  const history = messages.filter((m) => m.role !== "system");
  const stranded = session.vault.unresolved(JSON.stringify(history));
  return stranded.length > 0 ? localize(RESUMED_REDACTED, session.language).trim() : undefined;
}

/** Wire the pieces together. Construction only: nothing here runs a turn. */
async function buildSession(
  ctx: CommandContext,
  cwd: string,
  platform?: PlatformAccess,
  options: AgentOptions = {},
): Promise<Session> {
  const language = ctx.settings.language;
  const resumed = sessionToResume(cwd, options);
  const opening: AgentMessage[] = resumed?.messages ?? [
    { role: "system", content: localize(SYSTEM_PROMPT, language) },
  ];

  return {
    notice: resumeNotice(resumed, options, language),
    secrets: undefined, // set once a passphrase is known
    resumed: resumed !== undefined,

    id: resumed?.id ?? newSessionId(),
    createdAt: resumed?.createdAt ?? new Date().toISOString(),
    projectRoot: cwd,
    opening,
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
  askPassphrase: PassphraseAsker,
): Promise<void> {
  const ask = buildAsk(readLine);
  const messagesIn = session.opening;

  // Say which conversation this is before asking anything about it: a
  // passphrase prompt arriving first has no context to sit in.
  if (session.notice) write(session.notice + "\n");
  await openSavedSecrets(session, askPassphrase, write);

  // Only now is it known whether anything is actually stranded.
  const stranded = deadPlaceholderNotice(session, messagesIn);
  if (stranded) write(stranded + "\n");

  let messages = messagesIn;

  for (;;) {
    const raw = await readLine("> ");
    if (raw === undefined) return; // End of input: leave cleanly, like /exit.

    const input = raw.trim();
    if (input === "") continue;

    const slash = handleSlash(input, {
      language: session.language,
      vault: session.vault,
      projectRoot: session.projectRoot,
      sessionId: session.id,
      savingSecrets: session.secrets !== undefined,
    });
    if (slash.kind === "exit") return;
    if (slash.kind === "secrets") {
      if (slash.action === "save") await startSavingSecrets(session, askPassphrase, write);
      else stopSavingSecrets(session, write);
      continue;
    }
    if (slash.kind === "handled") {
      write(slash.text + "\n");
      continue;
    }

    messages = await takeTurn(messages, input, session, ask);
    persist(session, messages);
  }
}

/**
 * Start keeping the vault on disk, sealing it under a passphrase the user
 * supplies now. Refusing to accept an empty one is the whole safeguard.
 */
async function startSavingSecrets(
  session: Session,
  askPassphrase: PassphraseAsker,
  write: (s: string) => void,
): Promise<void> {
  const passphrase = (await askPassphrase(localize(ASK_PASSPHRASE, session.language)))?.trim();
  if (!passphrase) {
    write(localize(SECRETS_EMPTY, session.language) + "\n");
    return;
  }
  session.secrets = { passphrase };
  saveVault(session.id, session.vault, passphrase);
  write(localize(SECRETS_SAVED, session.language) + "\n");
}

/** Stop keeping it, and delete what was kept. */
function stopSavingSecrets(session: Session, write: (s: string) => void): void {
  session.secrets = undefined;
  forgetVault(session.id);
  write(localize(SECRETS_FORGOTTEN, session.language) + "\n");
}

/**
 * Offer to unlock a resumed session's saved vault.
 *
 * A wrong or skipped passphrase is not a reason to refuse to start: the
 * conversation is perfectly usable without it, and the placeholders simply
 * stay as text — which the tool guard already handles.
 */
async function openSavedSecrets(
  session: Session,
  askPassphrase: PassphraseAsker,
  write: (s: string) => void,
): Promise<void> {
  if (!hasVault(session.id)) return;

  const passphrase = (await askPassphrase(localize(ASK_PASSPHRASE_OPEN, session.language)))?.trim();
  if (!passphrase) {
    write(localize(SECRETS_SKIPPED, session.language) + "\n");
    return;
  }

  try {
    const snapshot = loadVault(session.id, passphrase);
    if (snapshot) {
      session.vault.absorb(snapshot);
      session.secrets = { passphrase };
    }
  } catch {
    // Wrong passphrase, or a file that has been altered. Same message either
    // way, deliberately: see redact/sealed.ts.
    write(localize(SECRETS_WRONG, session.language) + "\n");
    write(localize(SECRETS_SKIPPED, session.language) + "\n");
  }
}

/**
 * Write the conversation out after each turn, not at exit: the usual way a
 * session ends is a crash or a closed terminal, and neither runs cleanup.
 *
 * A failed write must not end the conversation in progress, so it is reported
 * once and the turn stands.
 */
function persist(session: Session, messages: AgentMessage[]): void {
  try {
    saveSession(
      recordFor(
        {
          id: session.id,
          projectRoot: session.projectRoot,
          model: session.model,
          language: session.language,
          createdAt: session.createdAt,
        },
        messages,
        session.vault,
      ),
    );
    if (session.secrets) saveVault(session.id, session.vault, session.secrets.passphrase);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.sink({ type: "error", message: `Could not save the session: ${message}` });
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
  // readline echoes typed characters to its `output`, so a stream that can be
  // silenced is what keeps a passphrase off the screen.
  const output = new MutableOutput(process.stdout);
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY ?? false,
  });

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

  const write = (text: string): void => {
    process.stdout.write(text);
  };
  const askPassphrase = passphraseAsker(output, () => nextMessage(), write);

  try {
    if (options.saveSecrets) await startSavingSecrets(session, askPassphrase, write);
    await repl(session, readLine, write, askPassphrase);
  } finally {
    rl.close();
  }
}
