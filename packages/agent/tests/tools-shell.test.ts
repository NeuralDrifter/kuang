// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { interpreterArgv, shellTool, probeInterpreters } from "../src/core/tools/shell.ts";

test("each interpreter gets its own argv, never a bare shell string", () => {
  expect(interpreterArgv("bash", "echo hi")).toEqual({ bin: "bash", args: ["-c", "echo hi"] });
  expect(interpreterArgv("python", "print(1)")).toEqual({
    bin: "python",
    args: ["-c", "print(1)"],
  });
  expect(interpreterArgv("pwsh", "echo hi")).toEqual({
    bin: "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-Command", "echo hi"],
  });
});

test("the interpreter enum offers only interpreters that exist", () => {
  const tool = shellTool(process.cwd(), ["bash"]);
  const params = tool.parameters as {
    properties: { interpreter: { enum: string[] } };
  };
  expect(params.properties.interpreter.enum).toEqual(["bash"]);
});

test("shell is never auto-approved", () => {
  expect(shellTool(process.cwd(), ["bash"]).tier).toBe("ask");
});

test("an unavailable interpreter is refused rather than silently substituted", async () => {
  const tool = shellTool(process.cwd(), ["bash"]);
  await expect(tool.run({ interpreter: "python", command: "print(1)" })).rejects.toThrow(
    /not available/,
  );
});

test("probeInterpreters finds at least one interpreter on this machine", async () => {
  expect((await probeInterpreters()).length).toBeGreaterThan(0);
});

test("preview shows the command and the interpreter", async () => {
  const tool = shellTool(process.cwd(), ["bash"]);
  const preview = await tool.preview!({ interpreter: "bash", command: "ls -la" });
  expect(preview.summary).toContain("ls -la");
  expect(preview.summary).toContain("bash");
});
