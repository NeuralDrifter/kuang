// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's file tools: read, write, edit, glob and grep (Task 8).
 *
 * Every path argument is resolved against `root` and refused if it escapes —
 * these tools run commands an AI proposed, so a path escape means reading or
 * writing anywhere on the user's disk. `write_file` and `edit_file` are tier
 * `ask` and show a unified diff before running, not after; `read_file`,
 * `glob` and `grep` are tier `auto`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Tool } from "./registry.ts";
import type { ToolPreview } from "../events.ts";
import { matchesPattern } from "../approvals.ts";

/** Resolve a project-relative path against `root`, refusing any escape. */
function resolveInProject(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path is outside the project: ${path}`);
  }
  return resolvedPath;
}

/** Forward-slashed path relative to `root`, for output and matching. */
function toRelative(root: string, absPath: string): string {
  return relative(resolve(root), absPath).replaceAll("\\", "/");
}

/** Minimal unified diff, adequate for approval previews. */
function unifiedDiff(before: string, after: string, path: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines = [`--- ${path}`, `+++ ${path}`];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) lines.push(`-${a[i]}`);
    if (b[i] !== undefined) lines.push(`+${b[i]}`);
  }
  return lines.join("\n");
}

/** Recursively list every file under `dir`, as project-relative forward-slash paths. */
function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walk(root, abs));
    } else if (entry.isFile()) {
      out.push(toRelative(root, abs));
    }
  }
  return out;
}

function readFileTool(root: string): Tool {
  return {
    name: "read_file",
    tier: "auto",
    description: { "en-US": "Read a file from the project", "zh-CN": "读取项目中的文件" },
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async (args) => {
      const path = String(args.path);
      const abs = resolveInProject(root, path);
      return readFile(abs, "utf-8");
    },
  };
}

function writeFileTool(root: string): Tool {
  async function readBefore(abs: string): Promise<string> {
    try {
      return await readFile(abs, "utf-8");
    } catch {
      return "";
    }
  }

  return {
    name: "write_file",
    tier: "ask",
    description: {
      "en-US": "Write a file in the project, creating it if needed",
      "zh-CN": "写入项目中的文件,如不存在则创建",
    },
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run: async (args) => {
      const path = String(args.path);
      const content = String(args.content);
      const abs = resolveInProject(root, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      return `Wrote ${bytes} bytes to ${path}`;
    },
    preview: async (args): Promise<ToolPreview> => {
      const path = String(args.path);
      const content = String(args.content);
      const abs = resolveInProject(root, path);
      const before = await readBefore(abs);
      return {
        summary: `write_file(${path})`,
        diff: unifiedDiff(before, content, path),
      };
    },
  };
}

function editFileTool(root: string): Tool {
  function countOccurrences(haystack: string, needle: string): number {
    if (needle === "") return 0;
    let count = 0;
    let index = 0;
    for (;;) {
      const found = haystack.indexOf(needle, index);
      if (found === -1) break;
      count++;
      index = found + needle.length;
    }
    return count;
  }

  async function applyEdit(root: string, args: Record<string, unknown>) {
    const path = String(args.path);
    const oldStr = String(args.old);
    const newStr = String(args.new);
    const abs = resolveInProject(root, path);
    const before = await readFile(abs, "utf-8");
    const occurrences = countOccurrences(before, oldStr);
    if (occurrences !== 1) {
      throw new Error(`Found ${occurrences} times; the match must be unique.`);
    }
    const after = before.replace(oldStr, newStr);
    return { path, abs, before, after };
  }

  return {
    name: "edit_file",
    tier: "ask",
    description: {
      "en-US": "Replace an exact, unique string within a file",
      "zh-CN": "替换文件中唯一匹配的精确字符串",
    },
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
      },
      required: ["path", "old", "new"],
    },
    run: async (args) => {
      const { abs, after } = await applyEdit(root, args);
      await writeFile(abs, after, "utf-8");
      return `Edited ${String(args.path)}`;
    },
    preview: async (args): Promise<ToolPreview> => {
      const { path, before, after } = await applyEdit(root, args);
      return {
        summary: `edit_file(${path})`,
        diff: unifiedDiff(before, after, path),
      };
    },
  };
}

function globTool(root: string): Tool {
  return {
    name: "glob",
    tier: "auto",
    description: {
      "en-US": "List project files matching a glob pattern",
      "zh-CN": "列出匹配 glob 模式的项目文件",
    },
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
    run: async (args) => {
      const pattern = String(args.pattern);
      const resolvedRoot = resolve(root);
      const all = walk(resolvedRoot, resolvedRoot);
      return all.filter((p) => matchesPattern(pattern, p)).join("\n");
    },
  };
}

function grepTool(root: string): Tool {
  return {
    name: "grep",
    tier: "auto",
    description: {
      "en-US": "Search project files for a pattern, optionally scoped by a glob",
      "zh-CN": "在项目文件中搜索匹配内容,可通过 glob 限定范围",
    },
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string" },
      },
      required: ["pattern"],
    },
    run: async (args) => {
      const pattern = String(args.pattern);
      const globPattern = typeof args.glob === "string" ? args.glob : undefined;
      const resolvedRoot = resolve(root);
      const files = walk(resolvedRoot, resolvedRoot).filter(
        (p) => globPattern === undefined || matchesPattern(globPattern, p),
      );
      const matches: string[] = [];
      for (const relPath of files) {
        const abs = join(resolvedRoot, relPath);
        let text: string;
        try {
          text = await readFile(abs, "utf-8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            matches.push(`${relPath}:${i + 1}: ${lines[i]}`);
          }
        }
      }
      return matches.join("\n");
    },
  };
}

/** The file tools: read, write, edit, glob and grep, rooted at `root`. */
export function fsTools(root: string): Tool[] {
  return [
    readFileTool(root),
    writeFileTool(root),
    editFileTool(root),
    globTool(root),
    grepTool(root),
  ];
}
