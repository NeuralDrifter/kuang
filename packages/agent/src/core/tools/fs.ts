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
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Tool } from "./registry.ts";
import type { ToolPreview } from "../events.ts";
import { diffFiles } from "../diff.ts";

/** Whether `target` is `root` itself or sits underneath it. */
function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * The real path of `target`, or of its deepest existing ancestor with the
 * missing tail appended.
 *
 * `write_file` creates files that do not exist yet, so plain `realpathSync`
 * would throw ENOENT on every new file. Resolving the deepest existing
 * ancestor is enough for containment: only a path segment that exists can be
 * a symlink, so no unresolved link can hide in the tail.
 */
function realpathOrNearest(target: string): string {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return target;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a project-relative path against `root`, refusing any escape.
 *
 * Two checks, because the lexical one alone is not containment. `../` and
 * absolute paths are caught by comparing resolved strings, but a **symlink
 * inside the project can point anywhere**, and `read_file` is tier `auto` —
 * it runs with no prompt. Cloning a repository containing a link named
 * `notes.txt` that points at `~/.ssh/id_rsa` would otherwise be enough to
 * read the key.
 *
 * The root is resolved too: it can itself be reached through a link (a
 * checkout under a symlinked home, `/tmp` on macOS), and comparing a real
 * path against a lexical root would then reject every legitimate file.
 *
 * The lexical path is what gets returned, so callers keep showing the user
 * the path they asked about rather than wherever it happens to live.
 */
export function resolveInProject(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  if (!contains(resolvedRoot, resolvedPath)) {
    throw new Error(`Path is outside the project: ${path}`);
  }

  if (!contains(realpathOrNearest(resolvedRoot), realpathOrNearest(resolvedPath))) {
    throw new Error(`Path escapes the project through a link: ${path}`);
  }
  return resolvedPath;
}

/** Forward-slashed path relative to `root`, for output and matching. */
function toRelative(root: string, absPath: string): string {
  return relative(resolve(root), absPath).replaceAll("\\", "/");
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

// Translate a glob pattern into an anchored RegExp, in one pass so a doubled
// star is consumed before a single star can match its first character.
// A doubled star here matches zero or more directories, unlike the stricter
// reading that requires it to cross at least one boundary: a model writing a
// leading doubled-star glob, or one nested under a directory, means "anywhere
// below", and the strict reading would silently under-match.
//  - a doubled star immediately followed by a slash also matches zero
//    directories (so the slash after it is optional)
//  - a doubled star alone matches anything, including slashes
//  - a single star matches anything within one path segment
//  - a question mark matches exactly one character within one path segment
//  - every other regex metacharacter is escaped
function globToRegExp(rawPattern: string): RegExp {
  // Collapse runs of consecutive `**/` segments to a single `**/` first. Each
  // one independently translates to an optional `(?:.*/)?` group; n of those
  // in a row backtrack catastrophically against a non-matching path (measured
  // ~x8 slower per added `**/`; 12 in a row took over 5s on an 18-segment
  // path), and `glob` is tier `auto` — a model-supplied `**/**/**/...` would
  // hang the agent with no approval prompt to interrupt it. Collapsing first
  // means there is only ever one `(?:.*/)?` per logical "any depth" gap.
  const pattern = rawPattern.replace(/(\*\*\/)+/g, "**/");
  let source = "^";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      source += "[^/]";
      i += 1;
    } else {
      const ch = pattern[i];
      source += REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  source += "$";
  return new RegExp(source);
}

/** Files above this size are skipped by `grep` rather than loaded whole. */
const MAX_GREP_FILE_BYTES = 1024 * 1024;
/** How many leading bytes `grep` probes for a NUL byte to detect binaries. */
const BINARY_PROBE_BYTES = 4096;
/** `grep` stops collecting matches after this many lines. */
const MAX_GREP_MATCHES = 200;

/**
 * Whether a file looks binary, by checking its first `BINARY_PROBE_BYTES`
 * bytes for a NUL byte. Node's UTF-8 decoder substitutes U+FFFD for invalid
 * bytes rather than throwing, so a try/catch around `readFile` cannot detect
 * this — the probe has to look at the raw bytes.
 */
async function isProbablyBinary(abs: string): Promise<boolean> {
  const handle = await open(abs, "r");
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Files whose contents are secrets. `read_file` is auto-tier — it runs with no
 * approval — so without this guard the agent can read a project's credentials
 * and send them to the API before the user ever sees a prompt. They are also
 * withheld from `glob` and `grep`, so their existence and contents never reach
 * the model at all.
 *
 * Matched on the basename, anchored, so `env.ts` and `keyboard.ts` stay
 * readable.
 */
const SECRET_FILES = [
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
];

/** Whether this path's basename names a secret-bearing file. */
export function isSecretFile(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  return SECRET_FILES.some((re) => re.test(name));
}

/** One entry found by the walk. */
interface Entry {
  /** Project-relative, forward slashes, no trailing slash. */
  path: string;
  isDir: boolean;
}

/**
 * Recursively list everything under `dir`. Directories are included: a model
 * asked "what folders are here?" and told nothing will confidently answer that
 * there are none.
 */
function walk(root: string, dir: string): Entry[] {
  const out: Entry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push({ path: toRelative(root, abs), isDir: true });
      out.push(...walk(root, abs));
    } else if (entry.isFile()) {
      if (isSecretFile(entry.name)) continue;
      out.push({ path: toRelative(root, abs), isDir: false });
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
      if (isSecretFile(path)) {
        throw new Error(`Refusing to read a sensitive file: ${path}`);
      }
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
    affects: (args) => String(args.path),
    preview: async (args): Promise<ToolPreview> => {
      const path = String(args.path);
      const content = String(args.content);

      if (isSecretFile(path)) {
        return {
          summary: `write_file(${path})`,
          diff: `[SECRET FILE] Diff hidden to prevent leaking secrets to the terminal.\nWARNING: The model is attempting to write to this file.`,
        };
      }

      const abs = resolveInProject(root, path);
      const before = await readBefore(abs);
      return {
        summary: `write_file(${path})`,
        diff: diffFiles(before, content, path).diff,
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
    // Splice by index rather than `before.replace(oldStr, newStr)`: a string
    // second argument to String.replace is a template where `$&`, `` $` ``,
    // `$'` and `$1` expand, so a model-supplied `new` would be silently
    // reinterpreted instead of written literally.
    const index = before.indexOf(oldStr);
    const after = before.slice(0, index) + newStr + before.slice(index + oldStr.length);
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
    affects: (args) => String(args.path),
    preview: async (args): Promise<ToolPreview> => {
      const path = String(args.path);

      if (isSecretFile(path)) {
        return {
          summary: `edit_file(${path})`,
          diff: `[SECRET FILE] Diff hidden to prevent leaking secrets to the terminal.\nWARNING: The model is attempting to edit this file.`,
        };
      }

      const { before, after } = await applyEdit(root, args);
      return {
        summary: `edit_file(${path})`,
        diff: diffFiles(before, after, path).diff,
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
      const raw = String(args.pattern);
      // A trailing slash means directories only, the way a shell glob does.
      const dirsOnly = raw.endsWith("/");
      const regex = globToRegExp(dirsOnly ? raw.slice(0, -1) : raw);
      const resolvedRoot = resolve(root);

      const hits = walk(resolvedRoot, resolvedRoot)
        .filter((e) => (dirsOnly ? e.isDir : true) && regex.test(e.path))
        .map((e) => e.path);

      // Say so rather than returning nothing. An empty result is ambiguous —
      // "no matches" and "the tool failed" look identical — and a model given
      // silence will fill it in, inventing filenames and then spending several
      // more calls discovering they were never there.
      if (hits.length === 0) return `No files in this project match ${raw}`;
      return hits.join("\n");
    },
  };
}

/**
 * The text of a file worth searching, or undefined when it is not one.
 *
 * Unreadable, oversized and binary files are all "skip this file" to a caller,
 * so they answer with the same `undefined` rather than three shapes of failure
 * inline in the scan loop.
 */
async function searchableText(abs: string): Promise<string | undefined> {
  try {
    if ((await stat(abs)).size > MAX_GREP_FILE_BYTES) return undefined;
    if (await isProbablyBinary(abs)) return undefined;
    return await readFile(abs, "utf-8");
  } catch {
    // Vanished, locked, or not a file. Nothing to search either way.
    return undefined;
  }
}

/** `path:line: text` for every line of `text` containing `pattern`. */
function matchingLines(relPath: string, text: string, pattern: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(pattern)) out.push(`${relPath}:${i + 1}: ${lines[i]}`);
  }
  return out;
}

/** Project files a glob admits, directories excluded. */
function searchableFiles(resolvedRoot: string, glob: string | undefined): string[] {
  const admits = glob === undefined ? undefined : globToRegExp(glob);
  return walk(resolvedRoot, resolvedRoot)
    .filter((entry) => !entry.isDir && (admits === undefined || admits.test(entry.path)))
    .map((entry) => entry.path);
}

/** Matches across the project, stopping once the cap is reached. */
async function collectMatches(
  resolvedRoot: string,
  pattern: string,
  glob: string | undefined,
): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = [];

  for (const relPath of searchableFiles(resolvedRoot, glob)) {
    const text = await searchableText(join(resolvedRoot, relPath));
    if (text === undefined) continue;

    for (const line of matchingLines(relPath, text, pattern)) {
      if (lines.length >= MAX_GREP_MATCHES) return { lines, truncated: true };
      lines.push(line);
    }
  }
  return { lines, truncated: false };
}

function renderMatches(
  { lines, truncated }: { lines: string[]; truncated: boolean },
  pattern: string,
): string {
  // As with glob: silence invites invention.
  if (lines.length === 0) return `No matches for ${pattern}`;

  const all = truncated
    ? [...lines, `(output truncated at ${MAX_GREP_MATCHES} matching lines)`]
    : lines;
  return all.join("\n");
}

function grepTool(root: string): Tool {
  return {
    name: "grep",
    tier: "auto",
    description: {
      "en-US":
        "Search project files for a literal substring (not a regular expression), " +
        "optionally scoped by a glob. Skips binary and oversized (>1MB) files and " +
        "caps output at 200 matching lines.",
      "zh-CN":
        "在项目文件中搜索一个字面子串(非正则表达式),可通过 glob 限定范围。" +
        "会跳过二进制文件和超过 1MB 的大文件,并将输出限制在 200 行匹配以内。",
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
      const glob = typeof args.glob === "string" ? args.glob : undefined;
      return renderMatches(await collectMatches(resolve(root), pattern, glob), pattern);
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
