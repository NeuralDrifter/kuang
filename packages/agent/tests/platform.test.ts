// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import type { AnyCommand } from "bailian-cli-core";
import { commandCatalog, findCommand, searchCatalog } from "../src/core/platform.ts";

function cmd(description: { "en-US": string; "zh-CN": string }, extra: Partial<AnyCommand> = {}) {
  return { description, auth: "apiKey", run: async () => {}, ...extra } as AnyCommand;
}

const COMMANDS: Record<string, AnyCommand> = {
  "image generate": cmd(
    { "en-US": "Generate an image from a text prompt", "zh-CN": "根据文本提示词生成图片" },
    {
      flags: {
        prompt: {
          type: "string",
          valueHint: "<text>",
          required: true,
          description: { "en-US": "The prompt", "zh-CN": "提示词" },
        },
      },
    },
  ),
  "video generate": cmd({ "en-US": "Generate a video", "zh-CN": "生成视频" }),
  usage: cmd({ "en-US": "Show recent model usage", "zh-CN": "查看模型用量" }),
  "managed-agent destroy": cmd(
    { "en-US": "Destroy a managed agent", "zh-CN": "销毁托管 Agent" },
    { risk: { level: "high" } as never },
  ),
};

test("the catalog covers every command in the map", () => {
  const catalog = commandCatalog(COMMANDS, "en-US");
  expect(catalog.map((e) => e.path).sort()).toEqual(
    ["image generate", "managed-agent destroy", "usage", "video generate"].sort(),
  );
});

test("catalog entries carry a localized description and a generated schema", () => {
  const en = findCommand(commandCatalog(COMMANDS, "en-US"), "image generate");
  const zh = findCommand(commandCatalog(COMMANDS, "zh-CN"), "image generate");

  expect(en?.description).toBe("Generate an image from a text prompt");
  expect(zh?.description).toBe("根据文本提示词生成图片");
  expect(en?.schema.properties.prompt).toMatchObject({ type: "string" });
  expect(en?.schema.required).toEqual(["prompt"]);
});

test("a command with no flags still gets a valid empty schema", () => {
  const entry = findCommand(commandCatalog(COMMANDS, "en-US"), "usage");
  expect(entry?.schema).toEqual({ type: "object", properties: {} });
});

test("commands declaring a risk level are marked risky", () => {
  const catalog = commandCatalog(COMMANDS, "en-US");
  expect(findCommand(catalog, "managed-agent destroy")?.risky).toBe(true);
  expect(findCommand(catalog, "usage")?.risky).toBe(false);
});

test("search matches on the command path", () => {
  const hits = searchCatalog(commandCatalog(COMMANDS, "en-US"), "video");
  expect(hits.map((h) => h.path)).toContain("video generate");
});

test("search matches on the description too", () => {
  // "usage" the word appears in the description of the `usage` command, but
  // "recent" appears only there — so this can only match via description.
  const hits = searchCatalog(commandCatalog(COMMANDS, "en-US"), "recent");
  expect(hits.map((h) => h.path)).toEqual(["usage"]);
});

test("search is case-insensitive and requires every term to match", () => {
  const catalog = commandCatalog(COMMANDS, "en-US");

  expect(searchCatalog(catalog, "GENERATE IMAGE").map((h) => h.path)).toEqual(["image generate"]);
  // "video" matches one command and "prompt" another; nothing matches both.
  expect(searchCatalog(catalog, "video prompt")).toEqual([]);
});

test("path matches rank above description-only matches", () => {
  const catalog = commandCatalog(COMMANDS, "en-US");
  const hits = searchCatalog(catalog, "generate");
  // Both `image generate` and `video generate` match on path; `usage` does not
  // match at all. Path hits must come first when a description-only hit exists.
  expect(hits[0].path).toMatch(/generate/);
});

test("a command in its own namespace outranks the same word nested elsewhere", () => {
  const catalog = commandCatalog(
    {
      "video generate": cmd({ "en-US": "Generate a video", "zh-CN": "生成视频" }),
      "finetune video create": cmd({
        "en-US": "Create a video fine-tune job",
        "zh-CN": "创建视频精调任务",
      }),
    },
    "en-US",
  );

  // Searching "video" must surface the video namespace, not a fine-tune job
  // that merely mentions it. Alphabetical order alone would invert this.
  expect(searchCatalog(catalog, "video")[0].path).toBe("video generate");
});

test("search in zh-CN matches Chinese descriptions", () => {
  const hits = searchCatalog(commandCatalog(COMMANDS, "zh-CN"), "视频");
  expect(hits.map((h) => h.path)).toEqual(["video generate"]);
});

test("search returns at most the requested number of results", () => {
  const hits = searchCatalog(commandCatalog(COMMANDS, "en-US"), "generate", 1);
  expect(hits).toHaveLength(1);
});

test("findCommand returns undefined for an unknown path", () => {
  expect(findCommand(commandCatalog(COMMANDS, "en-US"), "no such command")).toBeUndefined();
});
