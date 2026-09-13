// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery tools for the platform's own command surface.
 *
 * The CLI has 228 commands. Handing the model all of their schemas would cost
 * roughly 60k tokens on every turn, so instead it gets three small tools: search
 * for a command, read one command's schema, run one command. Resident cost is a
 * few hundred tokens and the whole platform stays reachable.
 *
 * The handful of commands worth immediate access — image, video, speech — are
 * promoted to first-class tools elsewhere; these cover the long tail.
 */
import type { FlagsDef, Language } from "bailian-cli-core";
import { localize } from "../i18n.ts";
import {
  commandCatalog,
  findCommand,
  searchCatalog,
  type CatalogEntry,
  type PlatformAccess,
} from "../platform.ts";
import { toCliFlag } from "./generate.ts";
import type { Tool } from "./registry.ts";

/** Command paths whose leading segment means the call changes remote state. */
const MUTATING = new Set(["create", "delete", "destroy", "deploy", "apply", "update", "remove"]);

/**
 * Render a model-supplied flag value as one argv element. Objects become JSON
 * rather than `[object Object]` — several flags (`--words <json>`) genuinely
 * take a JSON payload, so this is the useful behaviour as well as the safe one.
 */
function asArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asArgValue).join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** A model-supplied name that must be a plain string; anything else is invalid. */
function asIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the argv for one command. Always an array: a model-supplied flag value
 * containing `;` or `$(…)` stays one opaque element and can never become shell
 * syntax, because nothing ever joins this into a string.
 */
export function buildArgv(
  path: string,
  flags: Record<string, unknown>,
  defs: FlagsDef = {},
): string[] {
  const argv = path.split(/\s+/).filter(Boolean);

  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || value === null) continue;

    const flag = toCliFlag(name);
    // A switch carries no value: `true` means present, `false` means omit. A
    // boolean flag is the opposite — it needs its value spelled out. The two
    // are indistinguishable from the value alone, so consult the definition.
    // For a flag we have no definition for, assume switch semantics: omitting
    // an unknown boolean falls back to the command's default, whereas passing
    // `--flag false` to a real switch is a parse error.
    const isSwitch = defs[name] ? defs[name].type === "switch" : true;

    if (typeof value === "boolean" && isSwitch) {
      if (value) argv.push(flag);
      continue;
    }
    argv.push(flag, asArgValue(value));
  }

  // The agent parses results, so always ask for structured output.
  argv.push("--output", "json");
  return argv;
}

/** Whether running this command should require the user's approval. */
function needsApproval(entry: CatalogEntry): boolean {
  if (entry.risky) return true;
  return entry.path.split(/\s+/).some((segment) => MUTATING.has(segment));
}

/** Render an invocation the way the user would type it, for the approval prompt. */
function commandLine(path: string, flags: Record<string, unknown>, defs: FlagsDef = {}): string {
  const argv = buildArgv(path, flags, defs).slice(0, -2); // drop `--output json`
  return "kuang " + argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
}

const TEXT = {
  searchDescription: {
    "en-US":
      "Search the platform's commands by keyword. Returns matching command paths with a one-line description. Use this to discover capabilities beyond the tools listed here, then bl_describe_command to see a command's arguments.",
    "zh-CN":
      "按关键词搜索平台命令，返回匹配的命令路径及一行说明。用于发现此处未直接列出的能力，随后可用 bl_describe_command 查看命令参数。",
  },
  describeDescription: {
    "en-US": "Show one command's full argument schema, so it can be called with bl_run_command.",
    "zh-CN": "查看某个命令的完整参数结构，以便通过 bl_run_command 调用。",
  },
  runDescription: {
    "en-US":
      "Run one platform command. Use bl_search_commands and bl_describe_command first to find the path and its arguments.",
    "zh-CN": "执行一条平台命令。请先用 bl_search_commands 与 bl_describe_command 确认路径与参数。",
  },
  noMatches: {
    "en-US": "No commands matched. Try a broader keyword.",
    "zh-CN": "没有匹配的命令，请尝试更宽泛的关键词。",
  },
  unknownCommand: {
    "en-US": "Unknown command",
    "zh-CN": "未知命令",
  },
  failed: {
    "en-US": "Command failed",
    "zh-CN": "命令执行失败",
  },
} as const;

/** The three discovery tools, bound to a platform access. */
export function bailianTools(platform: PlatformAccess, language: Language): Tool[] {
  const catalog = commandCatalog(platform.commands, language);

  const resolve = (path: unknown): CatalogEntry => {
    const entry = findCommand(catalog, asIdentifier(path));
    if (!entry) {
      throw new Error(
        `${localize(TEXT.unknownCommand, language)}: ${asIdentifier(path) || "(not a string)"}`,
      );
    }
    return entry;
  };

  return [
    {
      name: "bl_search_commands",
      tier: "auto",
      description: TEXT.searchDescription,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. 'generate video' or 'quota'" },
        },
        required: ["query"],
      },
      run: async (args) => {
        const hits = searchCatalog(catalog, asIdentifier(args.query));
        if (hits.length === 0) return localize(TEXT.noMatches, language);
        return hits.map((h) => `${h.path} — ${h.description}`).join("\n");
      },
    },

    {
      name: "bl_describe_command",
      tier: "auto",
      description: TEXT.describeDescription,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Command path, e.g. 'image generate'" },
        },
        required: ["path"],
      },
      run: async (args) => {
        const entry = resolve(args.path);
        return JSON.stringify(
          {
            path: entry.path,
            description: entry.description,
            schema: entry.schema,
            requiresApproval: needsApproval(entry),
          },
          null,
          2,
        );
      },
    },

    {
      name: "bl_run_command",
      // Conservative by default: the tier is fixed at registration, but this
      // tool can reach any command, so it always asks. The preview shows the
      // exact command line, which is what the user actually needs to judge it.
      tier: "ask",
      description: TEXT.runDescription,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Command path, e.g. 'image generate'" },
          flags: {
            type: "object",
            description: "Flag names and values, as given by bl_describe_command",
          },
        },
        required: ["path"],
      },
      preview: async (args) => ({
        summary: commandLine(
          asIdentifier(args.path),
          (args.flags ?? {}) as Record<string, unknown>,
          platform.commands[asIdentifier(args.path)]?.flags ?? {},
        ),
      }),
      run: async (args) => {
        const entry = resolve(args.path);
        const flags = (args.flags ?? {}) as Record<string, unknown>;
        const defs = platform.commands[entry.path]?.flags ?? {};
        const result = await platform.invoke(buildArgv(entry.path, flags, defs));

        const body = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
        if (!result.ok) {
          return `${localize(TEXT.failed, language)} (exit ${result.exitCode})\n${body}`;
        }
        return body.trim() || "(no output)";
      },
    },
  ];
}
