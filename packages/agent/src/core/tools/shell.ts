// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's shell tool (Task 9).
 *
 * The prototype called `execSync(command)`, which on Windows routes through
 * `cmd.exe` — so most of what a model emits fails there. This tool instead
 * requires the model to pick an explicit interpreter and always spawns via
 * `execFile`-style argv arrays, never a single string handed to a shell. Only
 * interpreters actually found on the machine (`probeInterpreters`) are
 * offered in the schema; requesting one outside that list is refused rather
 * than silently substituted with another.
 */
import { execFile } from "node:child_process";
import type { Tool } from "./registry.ts";
import type { ToolPreview } from "../events.ts";

export type Interpreter = "pwsh" | "bash" | "python";

/** Every interpreter this tool knows how to offer, in probe/enum order. */
const KNOWN_INTERPRETERS: Interpreter[] = ["pwsh", "bash", "python"];

/** 120 s: long enough for real build/test commands, short enough to bound a hang. */
const TIMEOUT_MS = 120_000;
/** 10 MB: generous for command output, small enough to bound memory use. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Build the `execFile`-style argv for running `command` under `interpreter`. */
export function interpreterArgv(
  interpreter: Interpreter,
  command: string,
): { bin: string; args: string[] } {
  switch (interpreter) {
    case "bash":
      return { bin: "bash", args: ["-c", command] };
    case "python":
      return { bin: "python", args: ["-c", command] };
    case "pwsh":
      return { bin: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
}

/** Whether `bin` resolves on PATH, via `where` on Windows and `which` elsewhere. */
function onPath(bin: string): Promise<boolean> {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(cmd, [bin], { windowsHide: true }, (err) => resolve(!err));
  });
}

/** Which of `pwsh`, `bash`, `python` are reachable on this machine's PATH. */
export async function probeInterpreters(): Promise<Interpreter[]> {
  const found: Interpreter[] = [];
  for (const interpreter of KNOWN_INTERPRETERS) {
    if (await onPath(interpreter)) found.push(interpreter);
  }
  return found;
}

/** The shell tool: runs a command in an explicitly chosen, available interpreter. */
export function shellTool(root: string, available: Interpreter[]): Tool {
  return {
    name: "shell",
    tier: "ask",
    description: {
      "en-US": "Run a command in a chosen interpreter",
      "zh-CN": "在指定解释器中运行命令",
    },
    parameters: {
      type: "object",
      properties: {
        interpreter: { type: "string", enum: available },
        command: { type: "string" },
      },
      required: ["interpreter", "command"],
    },
    run: async (args) => {
      const interpreter = String(args.interpreter) as Interpreter;
      const command = String(args.command);
      if (!available.includes(interpreter)) {
        throw new Error(`Interpreter "${interpreter}" is not available on this machine.`);
      }
      const { bin, args: argv } = interpreterArgv(interpreter, command);
      return new Promise((resolve, reject) => {
        execFile(
          bin,
          argv,
          { cwd: root, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
          (err, stdout, stderr) => {
            const output = `${stdout}${stderr}`;
            if (err) {
              if (typeof err.code !== "number") {
                // Spawn-level failure (e.g. binary not found), not a nonzero exit.
                reject(err);
                return;
              }
              resolve(`Exit code ${err.code}:\n${output}`);
              return;
            }
            resolve(output);
          },
        );
      });
    },
    preview: async (args): Promise<ToolPreview> => {
      const interpreter = String(args.interpreter);
      const command = String(args.command);
      return { summary: `${interpreter}: ${command}` };
    },
  };
}
