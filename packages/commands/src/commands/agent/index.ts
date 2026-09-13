// SPDX-License-Identifier: Apache-2.0
// Modified 2026 by Michael P. Burgus <https://github.com/NeuralDrifter>
// Original: bailian-cli, Copyright 2026 Aliyun Model Studio (DashScope) AI Platform

import { execFile } from "node:child_process";
import { defineCommand, type AnyCommand, type LocalizedText } from "bailian-cli-core";
import { runAgent, type CommandInvoker, type PlatformAccess } from "kuang-agent";

const NO_DRY_RUN: LocalizedText = {
  "en-US": "The interactive agent does not support --dry-run.",
  "zh-CN": "交互式 Agent 不支持 --dry-run。",
};

/** stdout+stderr cap for one command run, matching the shell tool's limit. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Re-invoke this CLI out-of-process.
 *
 * Out-of-process because commands return `void` and write their results
 * straight to stdout: capturing that in-process would mean intercepting the
 * same stream the agent renders into. `execArgv` is carried over so the
 * TypeScript loader survives in development, where `argv[1]` is a `.ts` file
 * that plain node could not run; in a built install it is empty and harmless.
 *
 * Always an argv array — a model-supplied flag value never becomes shell
 * syntax, because nothing joins this into a string.
 */
export function makeCliInvoker(
  entry: string = process.argv[1],
  /**
   * Loader flags for the child. Defaults to this process's own, which is what
   * makes a `.ts` entry runnable in development. A caller running under a
   * different loader — a test runner, say — must pass its own.
   */
  execArgv: string[] = process.execArgv,
): CommandInvoker {
  return (argv, opts = {}) =>
    new Promise((resolve) => {
      const args = [...execArgv, entry, ...argv];
      if (opts.dryRun) args.push("--dry-run");

      execFile(
        process.execPath,
        args,
        {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code ?? 1)
              : error
                ? 1
                : 0;
          // A failed command is a result the model should read and react to,
          // not an exception that ends the turn.
          resolve({ ok: !error, stdout, stderr, exitCode });
        },
      );
    });
}

/** Re-invokes whichever entry started this process. */
const invoke = makeCliInvoker();

/**
 * The agent command.
 *
 * Takes the product command map as a getter rather than importing it: the map
 * is assembled in the product entry (`packages/cli/src/commands.ts`), which
 * sits above this package, and the getter defers the lookup until the command
 * actually runs so the map can reference this command while defining itself.
 */
export function agentCommand(getCommands: () => Record<string, AnyCommand>) {
  return defineCommand({
    description: {
      "en-US": "Launch the interactive agent",
      "zh-CN": "启动交互式 Agent",
    },
    auth: "apiKey",
    usageArgs: "[flags]",
    flags: {},
    async run(ctx) {
      if (ctx.settings.dryRun) {
        const language = ctx.settings.language;
        const text = NO_DRY_RUN;
        throw new Error(typeof text === "string" ? text : text[language]);
      }

      const platform: PlatformAccess = { commands: getCommands(), invoke };
      await runAgent(ctx, platform);
    },
  });
}

/** Local tools only — kept so the command still resolves without a map. */
export default agentCommand(() => ({}));
