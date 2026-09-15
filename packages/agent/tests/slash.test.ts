// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash commands. The bilingual pairs matter most here: a Chinese name that
 * quietly stopped resolving would look like a typo to the user rather than
 * like a bug, so each one is asserted against its English twin.
 */
import { expect, test } from "vite-plus/test";
import { RULES } from "../src/core/redact/rules.ts";
import { Vault } from "../src/core/redact/vault.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlash, type SlashContext } from "../src/core/slash.ts";

const CARD = "4111 1111 1111 1111";

function ctx(over: Partial<SlashContext> = {}): SlashContext {
  return { language: "en-US", vault: new Vault(), ...over };
}

/** The text of a command that was handled, or a failure if it was not. */
function say(input: string, c: SlashContext = ctx()): string {
  const out = handleSlash(input, c);
  if (out.kind !== "handled") throw new Error(`expected handled, got ${out.kind}`);
  return out.text;
}

// ── dispatch ────────────────────────────────────────────────────────────────

test("ordinary text is not a command", () => {
  expect(handleSlash("write me a haiku", ctx())).toEqual({ kind: "prompt" });
});

test("an absolute path is not a command", () => {
  // The most common way to type a slash first is to type a path.
  expect(handleSlash("/usr/local/bin/node --version", ctx())).toEqual({ kind: "prompt" });
  expect(handleSlash("/etc/hosts", ctx())).toEqual({ kind: "prompt" });
});

test("a bare slash is not a command", () => {
  expect(handleSlash("/", ctx())).toEqual({ kind: "prompt" });
});

test("an unknown command reports itself instead of reaching the model", () => {
  // Sending it would cost a round-trip and return a guess, not an answer.
  expect(say("/pil")).toContain("/pil");
  expect(say("/pil")).toContain("/help");
});

test("an unknown command reports itself in Chinese too", () => {
  expect(say("/脱敏x", ctx({ language: "zh-CN" }))).toContain("未知命令");
});

test("leading and trailing whitespace does not hide a command", () => {
  expect(handleSlash("  /exit  ", ctx())).toEqual({ kind: "exit" });
});

test("command names are case-insensitive", () => {
  expect(handleSlash("/EXIT", ctx())).toEqual({ kind: "exit" });
});

// ── /exit · /退出 ───────────────────────────────────────────────────────────

test("exit answers to both languages and to quit", () => {
  for (const name of ["/exit", "/退出", "/quit"]) {
    expect(handleSlash(name, ctx()), name).toEqual({ kind: "exit" });
  }
});

// ── /help · /帮助 ───────────────────────────────────────────────────────────

test("help lists every command with both its names", () => {
  const text = say("/help");
  expect(text).toContain("/pii");
  expect(text).toContain("/脱敏");
  expect(text).toContain("/exit");
  expect(text).toContain("/退出");
});

test("help is written in the session language", () => {
  expect(say("/help")).toContain("Leave the agent");
  expect(say("/帮助", ctx({ language: "zh-CN" }))).toContain("退出 Agent");
});

test("the Chinese help name resolves to the same text as the English one", () => {
  const c = ctx({ language: "zh-CN" });
  expect(say("/帮助", c)).toBe(say("/help", c));
});

// ── /pii · /脱敏 ────────────────────────────────────────────────────────────

test("pii with no argument reports the current state", () => {
  expect(say("/pii")).toContain("on");
});

test("pii off disables capture and pii on restores it", () => {
  const c = ctx();

  say("/pii off", c);
  expect(c.vault.enabled).toBe(false);
  expect(c.vault.sanitize(CARD).text).toBe(CARD);

  say("/pii on", c);
  expect(c.vault.enabled).toBe(true);
  expect(c.vault.sanitize(CARD).text).not.toContain("4111");
});

test("the Chinese toggle words work", () => {
  const c = ctx({ language: "zh-CN" });

  say("/脱敏 关闭", c);
  expect(c.vault.enabled).toBe(false);

  say("/脱敏 开启", c);
  expect(c.vault.enabled).toBe(true);
});

test("either language's command name accepts either language's argument", () => {
  // Someone reading English docs in a Chinese session should not be stuck.
  const c = ctx({ language: "zh-CN" });
  say("/脱敏 off", c);
  expect(c.vault.enabled).toBe(false);
  say("/pii 开", c);
  expect(c.vault.enabled).toBe(true);
});

test("turning it off says that captured values still restore", () => {
  const c = ctx();
  c.vault.sanitize(CARD);

  // Otherwise the reasonable fear is that /pii off strands what the model holds.
  expect(say("/pii off", c)).toContain("still restored");
});

test("turning it off is quiet when there is nothing to reassure anyone about", () => {
  expect(say("/pii off")).not.toContain("still restored");
});

test("the status counts what is being held", () => {
  const c = ctx();
  c.vault.sanitize(`${CARD} and mike@realdomain.co.uk`);

  const text = say("/pii", c);
  expect(text).toContain("CARD 1");
  expect(text).toContain("EMAIL 1");
});

test("an empty vault says so rather than printing a zero", () => {
  expect(say("/pii")).toContain("Nothing captured");
});

test("pii list shows what the rules actually cover", () => {
  const text = say("/pii list");

  // Built from RULES, so it cannot fall behind the rules that run.
  for (const rule of RULES) expect(text, rule.id).toContain(rule.id);
  expect(text).toContain("Chinese resident ID");
});

test("pii list is honest that it is best effort", () => {
  expect(say("/pii list")).toContain("not treat this as a guarantee");
});

test("pii list in Chinese uses the Chinese labels", () => {
  const text = say("/脱敏 列表", ctx({ language: "zh-CN" }));
  expect(text).toContain("中国居民身份证号");
});

test("a nonsense argument prints usage rather than doing something", () => {
  const c = ctx();
  expect(say("/pii maybe", c)).toContain("Usage");
  expect(c.vault.enabled).toBe(true);
});

test("every rule carries both labels", () => {
  // A missing zh-CN label silently falls back to English, which reads like a
  // half-translated product rather than a bug.
  for (const rule of RULES) {
    expect(typeof rule.label, rule.id).toBe("object");
    expect((rule.label as Record<string, string>)["zh-CN"], rule.id).toBeTruthy();
    expect((rule.label as Record<string, string>)["en-US"], rule.id).toBeTruthy();
  }
});

test("the held count is grammatical at one and at many", () => {
  const c = ctx();
  c.vault.sanitize(CARD);
  expect(say("/pii", c)).toContain("1 value the model");

  c.vault.sanitize("mike@realdomain.co.uk");
  expect(say("/pii", c)).toContain("2 values the model");
});

// ── /sessions · /会话 ───────────────────────────────────────────────────────

test("sessions answers to both names", () => {
  const c = ctx();
  expect(say("/sessions", c)).toBe(say("/会话", c));
});

test("sessions is listed in help, in both languages", () => {
  expect(say("/help")).toContain("/sessions");
  expect(say("/help")).toContain("/会话");
  expect(say("/帮助", ctx({ language: "zh-CN" }))).toContain("列出已保存的会话");
});

test("with no project root, sessions says there is nothing rather than guessing", () => {
  // The context is optional, so the command must not assume it is there.
  expect(say("/sessions")).toContain("No saved sessions");
});

test("an empty project lists nothing and says how one gets made", () => {
  const text = say("/sessions", ctx({ projectRoot: mkdtempSync(join(tmpdir(), "kuang-empty-")) }));
  expect(text).toContain("No saved sessions");
  expect(text).toContain("after your first reply");
});
