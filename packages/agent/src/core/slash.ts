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
import type { Vault } from "./redact/vault.ts";

/** What the REPL should do with a line it just read. */
export type SlashOutcome =
  /** Handled here; print `text` and read the next line. */
  | { kind: "handled"; text: string }
  /** Leave the REPL. */
  | { kind: "exit" }
  /** Not a command. Send it to the model as an ordinary prompt. */
  | { kind: "prompt" };

export interface SlashContext {
  language: Language;
  vault: Vault;
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
    "en-US": "Holding %n value(s) the model cannot see",
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
  badArg: {
    "en-US": "Usage: /pii [on|off|list]",
    "zh-CN": "用法：/脱敏 [开启|关闭|列表]",
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

function piiStatus(ctx: SlashContext): string {
  const t = (key: keyof typeof TEXT): string => localize(TEXT[key], ctx.language);
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
    lines.push(`${t("holding").replace("%n", String(total))} (${breakdown})`);
  }
  return lines.join("\n");
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
    args: { "en-US": "[on|off|list]", "zh-CN": "[开启|关闭|列表]" },
    run: (args, ctx) => {
      const t = (key: keyof typeof TEXT): string => localize(TEXT[key], ctx.language);
      const word = args[0]?.toLowerCase() ?? "";

      if (word === "") return { kind: "handled", text: piiStatus(ctx) };

      if (isList(word)) {
        const rows = RULES.map((rule): [string, string] => [
          rule.id,
          localize(rule.label, ctx.language),
        ]);
        return {
          kind: "handled",
          text: `${t("coverage")}\n${table(rows)}\n\n${t("bestEffort")}`,
        };
      }

      const on = parseToggle(word);
      if (on === undefined) return { kind: "handled", text: t("badArg") };

      const held = ctx.vault.stats().total;
      ctx.vault.setEnabled(on);
      // Turning it off does not strand what the model is already holding, and
      // saying so avoids the reasonable worry that it might. With nothing held
      // there is no worry to answer, and the line is just noise.
      const note = !on && held > 0 ? `\n${t("stillRestoring")}` : "";
      return { kind: "handled", text: piiStatus(ctx) + note };
    },
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
