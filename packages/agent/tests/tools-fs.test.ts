// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsTools } from "../src/core/tools/fs.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "kuang-fs-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n", "utf-8");
  return dir;
}

function tool(root: string, name: string) {
  const found = fsTools(root).find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

test("read_file returns file contents", async () => {
  const root = sandbox();
  expect(await tool(root, "read_file").run({ path: "src/a.ts" })).toBe("export const a = 1;\n");
});

test("read_file refuses to escape the project root", async () => {
  const root = sandbox();
  await expect(tool(root, "read_file").run({ path: "../../../etc/passwd" })).rejects.toThrow(
    /outside the project/,
  );
});

test("write_file writes and reports the byte count", async () => {
  const root = sandbox();
  const result = await tool(root, "write_file").run({ path: "src/c.ts", content: "x\n" });
  expect(readFileSync(join(root, "src", "c.ts"), "utf-8")).toBe("x\n");
  expect(result).toMatch(/2 bytes/);
});

test("write_file previews a diff before it runs", async () => {
  const root = sandbox();
  const preview = await tool(root, "write_file").preview!({
    path: "src/a.ts",
    content: "changed\n",
  });
  expect(preview.diff).toContain("-export const a = 1;");
  expect(preview.diff).toContain("+changed");
});

test("edit_file replaces an exact string", async () => {
  const root = sandbox();
  await tool(root, "edit_file").run({ path: "src/a.ts", old: "a = 1", new: "a = 99" });
  expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("export const a = 99;\n");
});

test("edit_file refuses an ambiguous match", async () => {
  const root = sandbox();
  writeFileSync(join(root, "src", "d.ts"), "x\nx\n", "utf-8");
  await expect(
    tool(root, "edit_file").run({ path: "src/d.ts", old: "x", new: "y" }),
  ).rejects.toThrow(/2 times/);
});

test("glob lists matching files relative to root", async () => {
  const root = sandbox();
  const out = await tool(root, "glob").run({ pattern: "src/*.ts" });
  expect(out.split("\n").sort()).toEqual(["src/a.ts", "src/b.ts"]);
});

test("grep reports file and line for matches", async () => {
  const root = sandbox();
  const out = await tool(root, "grep").run({ pattern: "const b" });
  expect(out).toContain("src/b.ts:1");
});

test("edit_file writes the replacement literally, not as a regex template", async () => {
  const root = sandbox();
  await tool(root, "edit_file").run({ path: "src/a.ts", old: "a = 1", new: "a = $& $1 done" });
  expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("export const a = $& $1 done;\n");
});

test("glob matches the patterns a model actually writes", async () => {
  const root = sandbox();
  writeFileSync(join(root, "top.ts"), "x\n", "utf-8");
  const g = tool(root, "glob");

  expect((await g.run({ pattern: "**/*.ts" })).split("\n").sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
    "top.ts",
  ]);
  expect((await g.run({ pattern: "src/**/*.ts" })).split("\n").sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
  ]);
  expect((await g.run({ pattern: "src/?.ts" })).split("\n").sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
  ]);
});

test("grep skips binary and oversized files and caps its output", async () => {
  const root = sandbox();
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x61, 0x00, 0x62]));
  writeFileSync(join(root, "big.txt"), "a\n".repeat(600_000), "utf-8");

  const out = await tool(root, "grep").run({ pattern: "a" });
  expect(out).not.toContain("bin.dat");
  expect(out).not.toContain("big.txt");
  expect(out.split("\n").length).toBeLessThanOrEqual(201);
});

test("read and search tools are auto-approved; writes ask", () => {
  const root = sandbox();
  expect(tool(root, "read_file").tier).toBe("auto");
  expect(tool(root, "glob").tier).toBe("auto");
  expect(tool(root, "grep").tier).toBe("auto");
  expect(tool(root, "write_file").tier).toBe("ask");
  expect(tool(root, "edit_file").tier).toBe("ask");
});
