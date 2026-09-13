// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import type { AnyCommand } from "bailian-cli-core";
import type { CommandInvoker, InvokeResult, PlatformAccess } from "../src/core/platform.ts";
import { mediaTools, SPENDS_CREDITS } from "../src/core/tools/media.ts";
import type { Tool } from "../src/core/tools/registry.ts";

/** Only the flags the hot-set tools actually pass need to exist here. */
function cmd(flagNames: string[], switches: string[] = []) {
  const flags: Record<string, unknown> = {};
  for (const n of flagNames) {
    flags[n] = {
      type: "string",
      valueHint: "<v>",
      description: { "en-US": n, "zh-CN": n },
    };
  }
  for (const n of switches) {
    flags[n] = { type: "switch", description: { "en-US": n, "zh-CN": n } };
  }
  return {
    description: { "en-US": "x", "zh-CN": "x" },
    auth: "apiKey",
    flags,
    run: async () => {},
  } as AnyCommand;
}

const COMMANDS: Record<string, AnyCommand> = {
  "image generate": cmd(["prompt", "size", "n", "negativePrompt", "outDir", "outPrefix"]),
  "video generate": cmd(["prompt", "image", "resolution", "ratio", "duration"], ["download"]),
  "speech synthesize": cmd(["text", "voice", "format", "out", "language"]),
  "speech recognize": cmd(["url", "language", "out"]),
  "vision describe": cmd(["image", "video", "prompt"]),
  "search web": cmd(["query", "count"]),
  "knowledge retrieve": cmd(["indexId", "query", "topK"]),
};

function platform(result: Partial<InvokeResult> = {}) {
  const calls: { argv: string[] }[] = [];
  const invoke: CommandInvoker = async (argv) => {
    calls.push({ argv });
    return { ok: true, stdout: "{}", stderr: "", exitCode: 0, ...result };
  };
  return { commands: COMMANDS, invoke, calls } as PlatformAccess & { calls: { argv: string[] }[] };
}

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const NAMES = [
  "generate_image",
  "generate_video",
  "text_to_speech",
  "transcribe_audio",
  "describe_image",
  "search_web",
  "retrieve_knowledge",
];

test("all seven hot-set tools are present", () => {
  const tools = mediaTools(platform(), "en-US");
  expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
});

test("tools that spend media credits ask; the rest run silently", () => {
  const tools = mediaTools(platform(), "en-US");

  for (const name of ["generate_image", "generate_video", "text_to_speech", "transcribe_audio"]) {
    expect(tool(tools, name).tier).toBe("ask");
  }
  for (const name of ["describe_image", "search_web", "retrieve_knowledge"]) {
    expect(tool(tools, name).tier).toBe("auto");
  }
});

test("the credit-spending set is exactly the ask-tier set", () => {
  const tools = mediaTools(platform(), "en-US");
  const asking = tools.filter((t) => t.tier === "ask").map((t) => t.name);
  expect([...SPENDS_CREDITS].sort()).toEqual(asking.sort());
});

test("every spending tool warns about cost before approval, in both languages", async () => {
  for (const language of ["en-US", "zh-CN"] as const) {
    const tools = mediaTools(platform(), language);
    for (const name of SPENDS_CREDITS) {
      const preview = await tool(tools, name).preview!({ prompt: "x", text: "x", url: "x" });
      // The user must know it costs money before answering, not after.
      expect(preview.summary.length).toBeGreaterThan(0);
      expect(preview.summary).toMatch(language === "zh-CN" ? /额度|credit/i : /credit/i);
    }
  }
});

test("every tool carries a bilingual description", () => {
  const tools = mediaTools(platform(), "en-US");
  for (const t of tools) {
    expect(typeof t.description).not.toBe("string");
    const d = t.description as { "en-US": string; "zh-CN": string };
    expect(d["en-US"].length).toBeGreaterThan(0);
    expect(d["zh-CN"].length).toBeGreaterThan(0);
    expect(d["en-US"]).not.toBe(d["zh-CN"]);
  }
});

test("generate_image invokes image generate with the prompt", async () => {
  const p = platform();
  await tool(mediaTools(p, "en-US"), "generate_image").run({ prompt: "a cat on mars", n: 2 });

  const argv = p.calls[0].argv;
  expect(argv.slice(0, 2)).toEqual(["image", "generate"]);
  expect(argv[argv.indexOf("--prompt") + 1]).toBe("a cat on mars");
  expect(argv[argv.indexOf("--n") + 1]).toBe("2");
});

test("generate_video always downloads, so the file lands locally", async () => {
  const p = platform();
  await tool(mediaTools(p, "en-US"), "generate_video").run({ prompt: "a cat" });

  const argv = p.calls[0].argv;
  expect(argv.slice(0, 2)).toEqual(["video", "generate"]);
  // Without this the command returns a URL and nothing reaches the project.
  expect(argv).toContain("--download");
});

test("text_to_speech passes the text through", async () => {
  const p = platform();
  await tool(mediaTools(p, "en-US"), "text_to_speech").run({ text: "hello", voice: "x" });

  const argv = p.calls[0].argv;
  expect(argv.slice(0, 2)).toEqual(["speech", "synthesize"]);
  expect(argv[argv.indexOf("--text") + 1]).toBe("hello");
});

test("transcribe_audio passes the url", async () => {
  const p = platform();
  await tool(mediaTools(p, "en-US"), "transcribe_audio").run({ url: "https://x/a.mp3" });
  expect(p.calls[0].argv[p.calls[0].argv.indexOf("--url") + 1]).toBe("https://x/a.mp3");
});

test("describe_image and search_web and retrieve_knowledge map to their commands", async () => {
  const p = platform();
  const tools = mediaTools(p, "en-US");

  await tool(tools, "describe_image").run({ image: "a.png", prompt: "what is this" });
  await tool(tools, "search_web").run({ query: "weather" });
  await tool(tools, "retrieve_knowledge").run({ indexId: "idx", query: "q" });

  expect(p.calls[0].argv.slice(0, 2)).toEqual(["vision", "describe"]);
  expect(p.calls[1].argv.slice(0, 2)).toEqual(["search", "web"]);
  expect(p.calls[2].argv.slice(0, 2)).toEqual(["knowledge", "retrieve"]);
  // camelCase becomes kebab-case on the command line.
  expect(p.calls[2].argv).toContain("--index-id");
});

test("a failing command returns its output rather than throwing", async () => {
  const p = platform({ ok: false, exitCode: 1, stderr: "insufficient balance" });
  const out = await tool(mediaTools(p, "en-US"), "generate_image").run({ prompt: "x" });

  // Credits run out; the model must see that and stop, not have the turn die.
  expect(out).toMatch(/insufficient balance/);
});

test("omitted optional arguments are not passed as empty flags", async () => {
  const p = platform();
  await tool(mediaTools(p, "en-US"), "generate_image").run({ prompt: "x" });

  const argv = p.calls[0].argv;
  expect(argv).not.toContain("--size");
  expect(argv).not.toContain("--n");
  expect(argv).not.toContain("--out-dir");
});

test("a prompt containing shell syntax stays one argv element", async () => {
  const p = platform();
  const nasty = "cat; rm -rf / && $(whoami)";
  await tool(mediaTools(p, "en-US"), "generate_image").run({ prompt: nasty });

  const argv = p.calls[0].argv;
  expect(argv[argv.indexOf("--prompt") + 1]).toBe(nasty);
});
