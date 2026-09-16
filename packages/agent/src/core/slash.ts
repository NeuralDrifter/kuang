// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash commands, resolved before anything reaches the model.
 *
 * Every command answers to an English name and a Chinese one, because the
 * interface is bilingual all the way down and a user working in Chinese
 * should not have to remember English verbs to drive it. The names are
 * aliases of one command, not two commands: `/pii on` and `/脱敏 开` do the
 * same thing and print in whichever language the session is set to.
 *
 * Lives in `core/` and returns text rather than printing, so the whole
 * surface is testable without a terminal and the future Ink renderer can
 * present the same results differently.
 */
import type { Language, LocalizedText } from "bailian-cli-core";
import { localize } from "./i18n.ts";
import { RULES } from "./redact/rules.ts";
import { listSessions } from "./session.ts";
import type { Vault } from "./redact/vault.ts";

/** What the REPL should do with a line it just read. */
export type SlashOutcome =
  /** Handled here; print `text` and read the next line. */
  | { kind: "handled"; text: string }
  /** Leave the REPL. */
  | { kind: "exit" }
  /** Not a command. Send it to the model as an ordinary prompt. */
  | { kind: "prompt" }
  /**
   * Start or stop keeping the vault on disk. Returned rather than done here:
   * saving needs a passphrase, prompting for one is terminal work, and `core/`
   * does not own a terminal.
   */
  | { kind: "secrets"; action: "save" | "forget" }
  /**
   * Switch between the flowing transcript and the split panes. Returned
   * rather than done here for the same reason as `secrets`: which layouts
   * exist is a question about the renderer, and `core/` does not own one.
   */
  | { kind: "layout" };

export interface SlashContext {
  language: Language;
  vault: Vault;
  /** Which project's sessions `/sessions` lists. */
  projectRoot?: string;
  /** The session in progress, marked in the listing so it is obvious. */
  sessionId?: string;
  /** Whether the vault is currently being kept on disk. Off by default. */
  savingSecrets?: boolean;
}

interface SlashCommand {
  /** Every accepted spelling, without the leading slash. */
  names: string[];
  summary: LocalizedText;
  /** Argument syntax, shown in `/help`. Omitted when there are none. */
  args?: LocalizedText;
  run: (args: string[], ctx: SlashContext) => SlashOutcome;
}

const TEXT = {
  on: { "en-US": "on", "zh-CN": "开启" },
  off: { "en-US": "off", "zh-CN": "关闭" },
  redaction: { "en-US": "Redaction", "zh-CN": "脱敏" },
  holding: {
    "en-US": "Holding %n value the model cannot see",
    "zh-CN": "已保管 %n 项模型无法看到的数据",
  },
  holdingPlural: {
    "en-US": "Holding %n values the model cannot see",
    "zh-CN": "已保管 %n 项模型无法看到的数据",
  },
  nothingHeld: {
    "en-US": "Nothing captured yet this session",
    "zh-CN": "本次会话尚未捕获任何数据",
  },
  stillRestoring: {
    "en-US": "Values already captured are still restored, so nothing you have seen will break.",
    "zh-CN": "已捕获的数据仍会被还原，因此不会影响你已经看到的内容。",
  },
  coverage: { "en-US": "Covers:", "zh-CN": "覆盖范围：" },
  bestEffort: {
    "en-US":
      "Best effort. Checksums keep the false positives down, but anything without one " +
      "can be missed — do not treat this as a guarantee.",
    "zh-CN": "尽力而为。校验和可降低误报，但没有校验和的数据可能被漏掉——请勿将其视为保证。",
  },
  commands: { "en-US": "Commands", "zh-CN": "命令" },
  unknown: {
    "en-US": "Unknown command: %s. Type /help to see what there is.",
    "zh-CN": "未知命令：%s。输入 /help 查看可用命令。",
  },
  sessionsHeader: { "en-US": "Sessions in this project", "zh-CN": "本项目的会话" },
  noSessions: {
    "en-US": "No saved sessions yet. One is written after your first reply.",
    "zh-CN": "尚无已保存的会话。第一次回复后会自动保存。",
  },
  current: { "en-US": "(current)", "zh-CN": "（当前）" },
  savingOn: {
    "en-US": "Captured values are kept on disk for this session, encrypted.",
    "zh-CN": "本会话捕获的数据将加密保存在磁盘上。",
  },
  savingOff: {
    "en-US": "Captured values stay in memory only, and are lost when you exit.",
    "zh-CN": "捕获的数据仅保存在内存中，退出后即丢失。",
  },
  resumeHint: {
    "en-US": "Reopen one with:  kuang agent --resume <id>",
    "zh-CN": "使用以下命令恢复：kuang agent --resume <id>",
  },
  badArg: {
    "en-US": "Usage: /pii [on|off|list|save|forget]",
    "zh-CN": "用法：/脱敏 [开启|关闭|列表|保存|忘记]",
  },
} satisfies Record<string, LocalizedText>;

/** `on`/`off` in either language, or `undefined` for anything else. */
function parseToggle(word: string): boolean | undefined {
  if (["on", "开", "开启", "启用"].includes(word)) return true;
  if (["off", "关", "关闭", "禁用"].includes(word)) return false;
  return undefined;
}

function isList(word: string): boolean {
  return ["list", "列表", "覆盖"].includes(word);
}

/** Two columns, padded on the display width of the left one. */
function table(rows: [string, string][], indent = "  "): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join("\n");
}

/** Resolve this module's bilingual strings for one session's language. */
function translator(language: Language): (key: keyof typeof TEXT) => string {
  return (key) => localize(TEXT[key], language);
}

function piiStatus(ctx: SlashContext): string {
  const t = translator(ctx.language);
  const state = ctx.vault.enabled ? t("on") : t("off");
  const { total, byRule } = ctx.vault.stats();

  const lines = [`${t("redaction")}: ${state}`];
  if (total === 0) {
    lines.push(t("nothingHeld"));
  } else {
    const breakdown = Object.entries(byRule)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, n]) => `${id} ${n}`)
      .join(", ");
    // "1 value(s)" reads like a placeholder someone forgot to finish.
    const phrase = total === 1 ? t("holding") : t("holdingPlural");
    lines.push(`${phrase.replace("%n", String(total))} (${breakdown})`);
  }
  // Whether anything captured outlives this process is the other half of
  // the answer to "what is being protected, and for how long".
  lines.push(t(ctx.savingSecrets ? "savingOn" : "savingOff"));
  return lines.join("\n");
}

/** What `/pii <word>` does. Each entry answers for one word, in either language. */
const PII_ACTIONS: { matches: (word: string) => boolean; run: (ctx: SlashContext) => string }[] = [
  { matches: (w) => w === "", run: piiStatus },
  { matches: isList, run: piiCoverage },
  { matches: (w) => parseToggle(w) === true, run: (ctx) => setRedaction(ctx, true) },
  { matches: (w) => parseToggle(w) === false, run: (ctx) => setRedaction(ctx, false) },
];

/** Words that ask for the vault to be kept, or not kept, on disk. */
function secretsAction(word: string): "save" | "forget" | undefined {
  if (["save", "keep", "保存", "记住"].includes(word)) return "save";
  if (["forget", "nosave", "忘记", "删除"].includes(word)) return "forget";
  return undefined;
}

function runPii(word: string, ctx: SlashContext): SlashOutcome {
  const secrets = secretsAction(word);
  if (secrets) return { kind: "secrets", action: secrets };

  const action = PII_ACTIONS.find((candidate) => candidate.matches(word));
  const text = action ? action.run(ctx) : translator(ctx.language)("badArg");
  return { kind: "handled", text };
}

/** Everything the rules cover, built from the rules themselves so it cannot drift. */
function piiCoverage(ctx: SlashContext): string {
  const t = translator(ctx.language);
  const rows = RULES.map((rule): [string, string] => [rule.id, localize(rule.label, ctx.language)]);
  return `${t("coverage")}\n${table(rows)}\n\n${t("bestEffort")}`;
}

function setRedaction(ctx: SlashContext, on: boolean): string {
  const held = ctx.vault.stats().total;
  ctx.vault.setEnabled(on);
  // Turning it off does not strand what the model is already holding, and
  // saying so avoids the reasonable worry that it might. With nothing held
  // there is no worry to answer, and the line is just noise.
  const note = !on && held > 0 ? "\n" + translator(ctx.language)("stillRestoring") : "";
  return piiStatus(ctx) + note;
}

/** This project's saved conversations, newest first. */
function sessionList(ctx: SlashContext): string {
  const t = translator(ctx.language);
  if (!ctx.projectRoot) return t("noSessions");

  const sessions = listSessions(ctx.projectRoot);
  if (sessions.length === 0) return t("noSessions");

  const rows = sessions.map((session): [string, string] => {
    const mark = session.id === ctx.sessionId ? ` ${t("current")}` : "";
    const when = session.updatedAt.slice(0, 16).replace("T", " ");
    return [session.id + mark, `${when}  ${session.title || "—"}`];
  });
  return [t("sessionsHeader"), table(rows), "", t("resumeHint")].join("\n");
}

const COMMANDS: SlashCommand[] = [
  {
    names: ["help", "帮助", "?"],
    summary: { "en-US": "Show this list", "zh-CN": "显示此列表" },
    run: (_args, ctx) => ({ kind: "handled", text: helpText(ctx.language) }),
  },
  {
    names: ["pii", "脱敏"],
    summary: {
      "en-US": "Hide secrets and personal data from the model",
      "zh-CN": "对模型隐藏密钥与个人数据",
    },
    args: {
      "en-US": "[on|off|list|save|forget]",
      "zh-CN": "[开启|关闭|列表|保存|忘记]",
    },
    run: (args, ctx) => runPii(args[0]?.toLowerCase() ?? "", ctx),
  },
  {
    names: ["sessions", "会话"],
    summary: { "en-US": "List saved conversations", "zh-CN": "列出已保存的会话" },
    run: (_args, ctx) => ({ kind: "handled", text: sessionList(ctx) }),
  },
  {
    names: ["panes", "分栏"],
    summary: {
      "en-US": "Split the screen into conversation and tool calls",
      "zh-CN": "将界面分为对话与工具调用两栏",
    },
    run: () => ({ kind: "layout" }),
  },
  {
    names: ["exit", "退出", "quit"],
    summary: { "en-US": "Leave the agent", "zh-CN": "退出 Agent" },
    run: () => ({ kind: "exit" }),
  },
];

function helpText(language: Language): string {
  const rows = COMMANDS.map((cmd): [string, string] => {
    const names = cmd.names.map((n) => `/${n}`).join(", ");
    const args = cmd.args ? ` ${localize(cmd.args, language)}` : "";
    return [`${names}${args}`, localize(cmd.summary, language)];
  });
  return `${localize(TEXT.commands, language)}\n${table(rows)}`;
}

/**
 * Whether `input` is meant as a command at all.
 *
 * A leading slash is also how most of the world writes an absolute path, so
 * `/usr/local/bin/node --version` must reach the model as a prompt rather
 * than being rejected as a typo. A command name is one word with no slash and
 * no dot in it, which leaves paths and filenames out.
 */
function looksLikeCommand(input: string): boolean {
  const first = input.slice(1).split(/\s/, 1)[0] ?? "";
  return first !== "" && !first.includes("/") && !first.includes(".");
}

/**
 * Interpret one line of input. Returns `{ kind: "prompt" }` when the line is
 * not a command and should go to the model unchanged.
 */
export function handleSlash(input: string, ctx: SlashContext): SlashOutcome {
  const line = input.trim();
  if (!line.startsWith("/") || !looksLikeCommand(line)) return { kind: "prompt" };

  const [head, ...args] = line.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const command = COMMANDS.find((c) => c.names.includes(name));

  if (!command) {
    // Silently sending a mistyped command to the model wastes a round-trip and
    // gets a guess back instead of an answer.
    return {
      kind: "handled",
      text: localize(TEXT.unknown, ctx.language).replace("%s", `/${head ?? ""}`),
    };
  }
  return command.run(args, ctx);
}
