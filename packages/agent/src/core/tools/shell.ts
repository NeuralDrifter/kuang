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
 *
 * `pwsh` (PowerShell 7) and `powershell` (Windows PowerShell 5.1, the only
 * shell guaranteed present on stock Windows) are both exposed under their
 * own names — never aliased to each other, since that would be exactly the
 * silent substitution this tool forbids. `python3` is probed only off
 * Windows: on Windows it commonly resolves to an App Execution Alias / Store
 * redirector stub or a WindowsApps `.bat` shim that `execFile` cannot spawn
 * directly (see CVE-2024-27980), so offering it there would be an interpreter
 * that appears available but fails every call.
 */
import { execFile, type ExecFileException } from "node:child_process";
import type { Tool } from "./registry.ts";
import type { ToolPreview } from "../events.ts";

export type Interpreter = "pwsh" | "powershell" | "bash" | "python" | "python3";

/** 120 s: long enough for real build/test commands, short enough to bound a hang. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 10 MB: generous for command output, small enough to bound memory use. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Windows PowerShell 5.1 pipes console output through the OEM codepage
 * (IBM437 on this machine), so any non-ASCII text — `中文`, say — arrives at
 * Node as `??` before Node ever gets to decode anything. Switching
 * `[Console]::OutputEncoding` to UTF-8 first fixes that. This is not a new
 * injection surface: the model-supplied `command` already executes as
 * PowerShell in that same `-Command` argument, so prepending more PowerShell
 * source to it changes nothing about what can be injected.
 */
const POWERSHELL_UTF8_PROLOGUE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n";

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
    case "python3":
      return { bin: "python3", args: ["-c", command] };
    case "pwsh":
      return { bin: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
    case "powershell":
      return {
        bin: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_UTF8_PROLOGUE + command],
      };
  }
}

/** Whether `interpreter` can actually be spawned and run a simple command. */
function onPath(interpreter: Interpreter): Promise<boolean> {
  const command = interpreter.startsWith("python") ? "print(1)" : "echo 1";
  const { bin, args } = interpreterArgv(interpreter, command);
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Every interpreter this tool knows how to offer, gated by platform where a
 * name would otherwise resolve to something broken:
 *  - `powershell` (Windows PowerShell 5.1) only exists on Windows.
 *  - `python3` is probed only off Windows, where it cannot silently resolve
 *    to an unspawnable Store/App-Execution-Alias stub.
 */
function candidateInterpreters(): Interpreter[] {
  const isWindows = process.platform === "win32";
  const candidates: Interpreter[] = ["pwsh"];
  if (isWindows) candidates.push("powershell");
  candidates.push("bash", "python");
  if (!isWindows) candidates.push("python3");
  return candidates;
}

/** Which interpreters are reachable on this machine's PATH, platform-gated. */
export async function probeInterpreters(): Promise<Interpreter[]> {
  const found: Interpreter[] = [];
  for (const interpreter of candidateInterpreters()) {
    if (await onPath(interpreter)) found.push(interpreter);
  }
  return found;
}

export interface ShellToolOptions {
  /** Milliseconds before the child process is killed. Defaults to 120000. */
  timeoutMs?: number;
}

/** The shell tool: runs a command in an explicitly chosen, available interpreter. */
/**
 * A failed run described for the model, or undefined when the failure is not
 * one the model can act on.
 *
 * Kept out of the callback so the happy path there is two lines. Every case
 * below still carries `output`: the model needs to see how far the command got.
 */
function describeFailure(
  err: ExecFileException,
  output: string,
  timeoutMs: number,
): string | undefined {
  // A genuine nonzero exit — not a spawn, timeout, or buffer fault.
  if (typeof err.code === "number") return `Exit code ${err.code}:\n${output}`;

  // The timeout fired. Node reports this with a non-numeric `code` (often
  // null) plus `killed: true`, and still hands back what was written so far.
  if (err.killed) return `Timed out after ${timeoutMs / 1000}s (killed).\n${output}`;

  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `Output exceeded 10 MB (truncated).\n${output}`;
  }

  // A spawn-level failure (ENOENT, EACCES, ...): there is no output at all.
  return undefined;
}

export function shellTool(root: string, available: Interpreter[], opts?: ShellToolOptions): Tool {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
        const spawnOptions = {
          cwd: root,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
        };
        execFile(bin, argv, spawnOptions, (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`;
          if (!err) {
            resolve(output);
            return;
          }
          const described = describeFailure(err, output, timeoutMs);
          // A failure with no output to show is the one case the model cannot
          // learn anything from, so it is the one case that rejects.
          if (described === undefined) reject(err);
          else resolve(described);
        });
      });
    },
    preview: async (args): Promise<ToolPreview> => {
      const interpreter = String(args.interpreter);
      const command = String(args.command);
      return { summary: `${interpreter}: ${command} (in ${root})` };
    },
  };
}
