// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import type { FlagsDef } from "bailian-cli-core";
import { flagsToJsonSchema, toCliFlag } from "../src/core/tools/generate.ts";

const FLAGS = {
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
    description: { "en-US": "Add a watermark", "zh-CN": "添加水印" },
  },
  size: {
    type: "string",
    valueHint: "<size>",
    choices: ["1024*1024", "2048*2048"] as const,
    description: { "en-US": "Image size", "zh-CN": "图片尺寸" },
  },
  words: {
    type: "array",
    valueHint: "<json>",
    description: { "en-US": "Hot words", "zh-CN": "热词" },
  },
  download: {
    type: "switch",
    description: { "en-US": "Download the result", "zh-CN": "下载结果" },
  },
} satisfies FlagsDef;

test("each flag type maps to its JSON Schema equivalent", () => {
  const schema = flagsToJsonSchema(FLAGS, "en-US");

  expect(schema.type).toBe("object");
  expect(schema.properties.prompt).toMatchObject({ type: "string" });
  expect(schema.properties.n).toMatchObject({ type: "number" });
  expect(schema.properties.watermark).toMatchObject({ type: "boolean" });
  expect(schema.properties.words).toMatchObject({
    type: "array",
    items: { type: "string" },
  });
  // A switch takes no value, so it is a boolean to the model.
  expect(schema.properties.download).toMatchObject({ type: "boolean" });
});

test("choices become an enum", () => {
  const schema = flagsToJsonSchema(FLAGS, "en-US");
  expect(schema.properties.size).toMatchObject({
    type: "string",
    enum: ["1024*1024", "2048*2048"],
  });
});

test("only flags marked required are required", () => {
  const schema = flagsToJsonSchema(FLAGS, "en-US");
  expect(schema.required).toEqual(["prompt"]);
});

test("a definition with no required flags omits the required key entirely", () => {
  const schema = flagsToJsonSchema({ n: FLAGS.n }, "en-US");
  // An empty `required: []` is legal but noisy; the key should be absent.
  expect("required" in schema).toBe(false);
});

test("descriptions resolve to the requested language", () => {
  // The value hint is appended (see the next test), so match the prose part.
  expect(flagsToJsonSchema(FLAGS, "en-US").properties.prompt.description).toContain("The prompt");
  expect(flagsToJsonSchema(FLAGS, "zh-CN").properties.prompt.description).toContain("提示词");
  // …and the two languages genuinely differ, so this is not passing by accident.
  expect(flagsToJsonSchema(FLAGS, "en-US").properties.prompt.description).not.toContain("提示词");
});

test("the value hint is carried into the description so the model sees the shape", () => {
  const schema = flagsToJsonSchema({ size: FLAGS.size }, "en-US");
  expect(schema.properties.size.description).toContain("<size>");
});

test("global flags are excluded — the agent sets those itself", () => {
  const withGlobals = {
    ...FLAGS,
    output: {
      type: "string",
      valueHint: "<format>",
      description: { "en-US": "Output format", "zh-CN": "输出格式" },
    },
    quiet: { type: "switch", description: { "en-US": "Quiet", "zh-CN": "安静" } },
    dryRun: { type: "switch", description: { "en-US": "Dry run", "zh-CN": "预览" } },
    help: { type: "switch", description: { "en-US": "Help", "zh-CN": "帮助" } },
  } satisfies FlagsDef;

  const schema = flagsToJsonSchema(withGlobals, "en-US");

  for (const global of ["output", "quiet", "dryRun", "help"]) {
    expect(global in schema.properties).toBe(false);
  }
  expect("prompt" in schema.properties).toBe(true);
});

test("an empty flag definition still produces a valid object schema", () => {
  const schema = flagsToJsonSchema({}, "en-US");
  expect(schema).toEqual({ type: "object", properties: {} });
});

test("camelCase flag names convert to their kebab-case CLI form", () => {
  expect(toCliFlag("prompt")).toBe("--prompt");
  expect(toCliFlag("maxTokens")).toBe("--max-tokens");
  expect(toCliFlag("imageToVideoModel")).toBe("--image-to-video-model");
  expect(toCliFlag("n")).toBe("--n");
});
