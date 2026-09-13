// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import type { AnyCommand } from "bailian-cli-core";
import type { CommandInvoker, InvokeResult, PlatformAccess } from "../src/core/platform.ts";
import { bailianTools, buildArgv } from "../src/core/tools/bailian.ts";
import type { Tool } from "../src/core/tools/registry.ts";

function cmd(en: string, zh: string, extra: Partial<AnyCommand> = {}) {
  return {
    description: { "en-US": en, "zh-CN": zh },
    auth: "apiKey",
    run: async () => {},
    ...extra,
  } as AnyCommand;
}

const COMMANDS: Record<string, AnyCommand> = {
  "image generate": cmd("Generate an image", "生成图片", {
    flags: {
      prompt: {
        type: "string",
        valueHint: "<text>",
        required: true,
        description: { "en-US": "The prompt", "zh-CN": "提示词" },
      },
      n: {
        type: "number",
        valueHint: "<count>",
        description: { "en-US": "How many", "zh-CN": "数量" },
      },
      watermark: {
        type: "boolean",
        valueHint: "<bool>",
        description: { "en-US": "Watermark", "zh-CN": "水印" },
      },
      words: {
        type: "array",
        valueHint: "<list>",
        description: { "en-US": "Words", "zh-CN": "词" },
      },
      download: { type: "switch", description: { "en-US": "Download", "zh-CN": "下载" } },
    },
  }),
  usage: cmd("Show recent usage", "查看用量"),
  "managed-agent destroy": cmd("Destroy an agent", "销毁 Agent", {
    risk: { level: "high" } as never,
  }),
};

/** Records what the tool asked for, and replies with whatever is configured. */
function mockInvoker(result: Partial<InvokeResult> = {}) {
  const calls: { argv: string[]; opts?: { dryRun?: boolean } }[] = [];
  const invoke: CommandInvoker = async (argv, opts) => {
    calls.push({ argv, opts });
    return { ok: true, stdout: "{}", stderr: "", exitCode: 0, ...result };
  };
  return { invoke, calls };
}

function platform(
  result?: Partial<InvokeResult>,
): PlatformAccess & { calls: { argv: string[] }[] } {
  const { invoke, calls } = mockInvoker(result);
  return { commands: COMMANDS, invoke, calls };
}

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

// ── argv construction ───────────────────────────────────────────────────────

test("a command path becomes separate argv elements", () => {
  expect(buildArgv("managed-agent destroy", {})).toEqual([
    "managed-agent",
    "destroy",
    "--output",
    "json",
  ]);
});

test("each flag type renders into argv correctly", () => {
  const defs = COMMANDS["image generate"].flags!;
  const argv = buildArgv(
    "image generate",
    { prompt: "a cat", n: 2, watermark: false, words: ["a", "b"], download: true },
    defs,
  );

  expect(argv.slice(0, 2)).toEqual(["image", "generate"]);
  expect(argv).toContain("--prompt");
  expect(argv[argv.indexOf("--prompt") + 1]).toBe("a cat");
  expect(argv[argv.indexOf("--n") + 1]).toBe("2");
  expect(argv[argv.indexOf("--watermark") + 1]).toBe("false");
  expect(argv[argv.indexOf("--words") + 1]).toBe("a,b");
  // A switch is present alone, with no value following it.
  expect(argv).toContain("--download");
  expect(argv[argv.indexOf("--download") + 1]).not.toBe("true");
});

test("a false switch is omitted, but a false boolean flag keeps its value", () => {
  const defs = COMMANDS["image generate"].flags!;
  // `download` is a switch and `watermark` is a boolean — both arrive as
  // `false`, and only the definition tells them apart.
  expect(buildArgv("image generate", { download: false }, defs)).not.toContain("--download");
  expect(buildArgv("image generate", { watermark: false }, defs)).toContain("--watermark");
});

test("camelCase flags become kebab-case on the command line", () => {
  expect(buildArgv("image generate", { maxTokens: 10 })).toContain("--max-tokens");
});

test("a value containing spaces or quotes stays a single argv element", () => {
  const nasty = 'a "cat"; rm -rf / && echo $(whoami)';
  const argv = buildArgv("image generate", { prompt: nasty });
  // Never a shell string — the dangerous text is one opaque element.
  expect(argv[argv.indexOf("--prompt") + 1]).toBe(nasty);
  expect(argv.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
});

test("undefined and null flag values are skipped", () => {
  const argv = buildArgv("image generate", { prompt: "x", n: undefined, words: null });
  expect(argv).not.toContain("--n");
  expect(argv).not.toContain("--words");
  expect(argv).toContain("--prompt");
});

test("json output is always requested so results can be parsed", () => {
  const argv = buildArgv("usage", {});
  expect(argv.slice(-2)).toEqual(["--output", "json"]);
});

// ── bl_search_commands ──────────────────────────────────────────────────────

test("search returns matching command paths with descriptions", async () => {
  const tools = bailianTools(platform(), "en-US");
  const out = await tool(tools, "bl_search_commands").run({ query: "image" });

  expect(out).toContain("image generate");
  expect(out).toContain("Generate an image");
});

test("search reports no matches rather than returning an empty string", async () => {
  const tools = bailianTools(platform(), "en-US");
  const out = await tool(tools, "bl_search_commands").run({ query: "zzzznothing" });
  expect(out.trim().length).toBeGreaterThan(0);
});

// ── bl_describe_command ─────────────────────────────────────────────────────

test("describe returns the generated schema for a command", async () => {
  const tools = bailianTools(platform(), "en-US");
  const out = await tool(tools, "bl_describe_command").run({ path: "image generate" });
  const parsed = JSON.parse(out);

  expect(parsed.path).toBe("image generate");
  expect(parsed.schema.properties.prompt).toMatchObject({ type: "string" });
  expect(parsed.schema.required).toEqual(["prompt"]);
});

test("describe refuses an unknown command instead of inventing one", async () => {
  const tools = bailianTools(platform(), "en-US");
  await expect(tool(tools, "bl_describe_command").run({ path: "no such thing" })).rejects.toThrow(
    /unknown command/i,
  );
});

// ── bl_run_command ──────────────────────────────────────────────────────────

test("run invokes the command with the constructed argv", async () => {
  const p = platform({ stdout: '{"ok":true}' });
  const tools = bailianTools(p, "en-US");

  await tool(tools, "bl_run_command").run({ path: "usage", flags: {} });

  expect(p.calls).toHaveLength(1);
  expect(p.calls[0].argv.slice(0, 1)).toEqual(["usage"]);
});

test("run refuses an unknown command without invoking anything", async () => {
  const p = platform();
  const tools = bailianTools(p, "en-US");

  await expect(
    tool(tools, "bl_run_command").run({ path: "no such thing", flags: {} }),
  ).rejects.toThrow(/unknown command/i);
  expect(p.calls).toHaveLength(0);
});

test("a failing command returns its output instead of throwing", async () => {
  const tools = bailianTools(
    platform({ ok: false, exitCode: 1, stdout: "", stderr: "quota exceeded" }),
    "en-US",
  );
  const out = await tool(tools, "bl_run_command").run({ path: "usage", flags: {} });

  // The model must see the failure and react, not have the turn end.
  expect(out).toMatch(/quota exceeded/);
  expect(out).toMatch(/exit|fail/i);
});

test("non-JSON stdout is returned raw rather than crashing the parse", async () => {
  const tools = bailianTools(platform({ stdout: "plain text result" }), "en-US");
  const out = await tool(tools, "bl_run_command").run({ path: "usage", flags: {} });
  expect(out).toContain("plain text result");
});

// ── approval tiers ──────────────────────────────────────────────────────────

test("discovery tools are auto-approved; running a command is not", () => {
  const tools = bailianTools(platform(), "en-US");

  expect(tool(tools, "bl_search_commands").tier).toBe("auto");
  expect(tool(tools, "bl_describe_command").tier).toBe("auto");
  expect(tool(tools, "bl_run_command").tier).toBe("ask");
});

test("running a command previews the exact command line before approval", async () => {
  const tools = bailianTools(platform(), "en-US");
  const preview = await tool(tools, "bl_run_command").preview!({
    path: "image generate",
    flags: { prompt: "a cat" },
  });

  expect(preview.summary).toContain("image generate");
  expect(preview.summary).toContain("a cat");
});

test("an object flag value becomes JSON, not [object Object]", () => {
  // Flags like `--words <json>` genuinely take a JSON payload.
  const argv = buildArgv("image generate", { words: { hot: ["a", "b"] } });
  expect(argv[argv.indexOf("--words") + 1]).toBe('{"hot":["a","b"]}');
});

test("a non-string command path is refused rather than coerced", async () => {
  const p = platform();
  const tools = bailianTools(p, "en-US");
  await expect(
    tool(tools, "bl_run_command").run({ path: { nested: "x" }, flags: {} }),
  ).rejects.toThrow(/unknown command/i);
  expect(p.calls).toHaveLength(0);
});
