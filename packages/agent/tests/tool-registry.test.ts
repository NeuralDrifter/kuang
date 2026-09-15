// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { ToolRegistry, type Tool } from "../src/core/tools/registry.ts";

function echoTool(name = "echo"): Tool {
  return {
    name,
    tier: "auto",
    description: { "en-US": "Echo the input", "zh-CN": "回显输入" },
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: async (args) => String(args.text),
  };
}

test("registers a tool and hands it back", async () => {
  const r = new ToolRegistry();
  r.register(echoTool());
  // The loop takes the tool and runs it itself, so `get` is the whole contract.
  expect(await r.get("echo")!.run({ text: "hi" })).toBe("hi");
});

test("rejects duplicate tool names", () => {
  const r = new ToolRegistry();
  r.register(echoTool());
  expect(() => r.register(echoTool())).toThrow(/already registered/);
});

test("an unknown tool is undefined, for the caller to refuse", async () => {
  const r = new ToolRegistry();
  expect(r.get("nope")).toBeUndefined();
});

test("schemas are emitted in the requested language", () => {
  const r = new ToolRegistry();
  r.register(echoTool());
  expect(r.schemas("en-US")[0].function.description).toBe("Echo the input");
  expect(r.schemas("zh-CN")[0].function.description).toBe("回显输入");
});

test("schemas carry the OpenAI function-tool shape", () => {
  const r = new ToolRegistry();
  r.register(echoTool());
  const [schema] = r.schemas("en-US");
  expect(schema.type).toBe("function");
  expect(schema.function.name).toBe("echo");
  expect(schema.function.parameters).toEqual({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  });
});
