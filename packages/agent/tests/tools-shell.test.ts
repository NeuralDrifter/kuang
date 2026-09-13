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

test("windows powershell gets its own argv with a UTF-8 prologue", () => {
  const { bin, args } = interpreterArgv("powershell", "echo hi");
  expect(bin).toBe("powershell");
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  // Windows PowerShell 5.1 pipes output in the OEM codepage (IBM437 here), so
  // `中文` arrives as `??` before Node sees it. The prologue fixes that.
  expect(args[3]).toContain("OutputEncoding");
  expect(args[3]).toContain("echo hi");
});

test("python3 runs with -c like python", () => {
  expect(interpreterArgv("python3", "print(1)")).toEqual({
    bin: "python3",
    args: ["-c", "print(1)"],
  });
});

test("a timed-out command resolves with its partial output instead of throwing", async () => {
  const tool = shellTool(process.cwd(), ["bash"], { timeoutMs: 300 });
  const out = await tool.run({ interpreter: "bash", command: "echo started; sleep 5" });

  expect(out).toMatch(/timed out/i);
  expect(out).toContain("started");
});

test("preview shows the command, the interpreter and where it will run", async () => {
  const tool = shellTool(process.cwd(), ["bash"]);
  const preview = await tool.preview!({ interpreter: "bash", command: "ls -la" });

  expect(preview.summary).toContain("ls -la");
  expect(preview.summary).toContain("bash");
  // Approving `rm -rf build` without seeing the directory is not informed consent.
  expect(preview.summary).toContain(process.cwd());
});
