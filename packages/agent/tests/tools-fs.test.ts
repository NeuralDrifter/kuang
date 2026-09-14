// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
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
  // Over 1 MB: skipped by size before it is ever read.
  writeFileSync(join(root, "big.txt"), "a\n".repeat(600_000), "utf-8");
  // Small but with more matches than the cap, so the cap is actually exercised.
  writeFileSync(join(root, "many.txt"), "a\n".repeat(300), "utf-8");

  const out = await tool(root, "grep").run({ pattern: "a" });
  const lines = out.split("\n");

  expect(out).not.toContain("bin.dat");
  expect(out).not.toContain("big.txt");
  expect(out).toContain("many.txt");
  expect(lines).toHaveLength(201);
  expect(lines.at(-1)).toMatch(/truncated/i);
});

test("a pathological glob pattern cannot hang the agent", async () => {
  const root = sandbox();
  const pattern = "**/".repeat(14) + "*.ts";
  const started = Date.now();
  await tool(root, "glob").run({ pattern });
  expect(Date.now() - started).toBeLessThan(1000);
});

test("read and search tools are auto-approved; writes ask", () => {
  const root = sandbox();
  expect(tool(root, "read_file").tier).toBe("auto");
  expect(tool(root, "glob").tier).toBe("auto");
  expect(tool(root, "grep").tier).toBe("auto");
  expect(tool(root, "write_file").tier).toBe("ask");
  expect(tool(root, "edit_file").tier).toBe("ask");
});

// ── directories are visible ─────────────────────────────────────────────────

test("glob lists directories, not only files", async () => {
  const root = sandbox();
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });

  const out = (await tool(root, "glob").run({ pattern: "*" })).split("\n");

  // Answering "what folders are here?" with silence is worse than an error:
  // the model reports confidently that there are none.
  expect(out).toContain("docs");
  expect(out).toContain("tools");
});

test("a trailing slash matches directories only", async () => {
  const root = sandbox();
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "top.ts"), "x\n", "utf-8");

  const out = (await tool(root, "glob").run({ pattern: "*/" })).split("\n").filter(Boolean);

  // The sandbox already contains src/, so both root directories match.
  expect(out.sort()).toEqual(["docs", "src"]);
  expect(out).not.toContain("top.ts");
});

test("nested directories are listed under a recursive pattern", async () => {
  const root = sandbox();
  mkdirSync(join(root, "a", "b"), { recursive: true });

  const out = (await tool(root, "glob").run({ pattern: "**/" })).split("\n").filter(Boolean);

  expect(out).toContain("a");
  expect(out).toContain("a/b");
});

// ── secrets ─────────────────────────────────────────────────────────────────

test("read_file refuses secret-bearing files", async () => {
  const root = sandbox();
  writeFileSync(join(root, ".env"), "API_KEY=sk-real-secret\n", "utf-8");

  // read_file is auto-tier: without this guard the agent reads the user's
  // credentials and ships them to the API with no prompt at all.
  await expect(tool(root, "read_file").run({ path: ".env" })).rejects.toThrow(/sensitive/i);
});

test("the secret guard covers the usual credential files", async () => {
  const root = sandbox();
  for (const name of [".env", ".env.local", "id_rsa", "server.pem", "app.key", ".npmrc"]) {
    writeFileSync(join(root, name), "secret\n", "utf-8");
    await expect(tool(root, "read_file").run({ path: name })).rejects.toThrow(/sensitive/i);
  }
});

test("ordinary files that merely look similar are still readable", async () => {
  const root = sandbox();
  writeFileSync(join(root, "env.ts"), "export const x = 1;\n", "utf-8");
  writeFileSync(join(root, "keyboard.ts"), "export const y = 2;\n", "utf-8");

  expect(await tool(root, "read_file").run({ path: "env.ts" })).toContain("export const x");
  expect(await tool(root, "read_file").run({ path: "keyboard.ts" })).toContain("export const y");
});

test("secret files are hidden from glob and grep", async () => {
  const root = sandbox();
  writeFileSync(join(root, ".env"), "API_KEY=sk-real-secret\n", "utf-8");

  expect(await tool(root, "glob").run({ pattern: "*" })).not.toContain(".env");
  // grep must not leak the contents either.
  expect(await tool(root, "grep").run({ pattern: "sk-real" })).not.toContain("sk-real-secret");
});

// ── symlink containment ─────────────────────────────────────────────────────
//
// The lexical check catches `../` and absolute paths. It cannot catch a link
// inside the project pointing out of it, and `read_file` is tier `auto`, so
// that path runs with no prompt at all.

/** Windows needs Developer Mode or admin to create symlinks. Skip, don't fail. */
const CAN_SYMLINK = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), "kuang-link-"));
    writeFileSync(join(probe, "target"), "x", "utf-8");
    symlinkSync(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!CAN_SYMLINK)(
  "read_file refuses a symlink that points out of the project",
  async () => {
    const outside = mkdtempSync(join(tmpdir(), "kuang-outside-"));
    writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY", "utf-8");

    const root = sandbox();
    // Exactly the hostile-repository case: an innocuous name, a link body.
    symlinkSync(join(outside, "id_rsa"), join(root, "notes.txt"));

    await expect(tool(root, "read_file").run({ path: "notes.txt" })).rejects.toThrow(/link/i);
  },
);

test.skipIf(!CAN_SYMLINK)("write_file refuses to write through an escaping symlink", async () => {
  const outside = mkdtempSync(join(tmpdir(), "kuang-outside-"));
  writeFileSync(join(outside, "authorized_keys"), "", "utf-8");

  const root = sandbox();
  symlinkSync(join(outside, "authorized_keys"), join(root, "keys.txt"));

  await expect(
    tool(root, "write_file").run({ path: "keys.txt", content: "ssh-rsa AAAA" }),
  ).rejects.toThrow(/link/i);
  // The file outside must be untouched, not merely un-returned.
  expect(readFileSync(join(outside, "authorized_keys"), "utf-8")).toBe("");
});

test.skipIf(!CAN_SYMLINK)("a symlink that stays inside the project still resolves", async () => {
  const root = sandbox();
  symlinkSync(join(root, "src", "a.ts"), join(root, "alias.ts"));

  // Containment, not a ban on links.
  expect(await tool(root, "read_file").run({ path: "alias.ts" })).toBe("export const a = 1;\n");
});

test.skipIf(!CAN_SYMLINK)("a project reached through a symlinked root still works", async () => {
  const real = sandbox();
  const parent = mkdtempSync(join(tmpdir(), "kuang-linkroot-"));
  const linked = join(parent, "project");
  symlinkSync(real, linked, "junction");

  // Resolving the file but not the root would make every file look external:
  // a checkout under a symlinked home, or anything under /tmp on macOS.
  expect(await tool(linked, "read_file").run({ path: "src/a.ts" })).toBe("export const a = 1;\n");
});

test("write_file still creates a file that does not exist yet", async () => {
  const root = sandbox();

  // realpath throws ENOENT on a path that isn't there, so containment has to
  // resolve the deepest existing ancestor instead of the target itself.
  await tool(root, "write_file").run({ path: "src/deep/new/file.ts", content: "ok\n" });
  expect(readFileSync(join(root, "src", "deep", "new", "file.ts"), "utf-8")).toBe("ok\n");
});

/**
 * Windows refuses unprivileged symlinks but allows directory junctions, and a
 * junction escapes the project exactly the same way. Without this, the
 * containment check ships untested on the platform being developed on.
 */
const CAN_JUNCTION = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), "kuang-junction-"));
    mkdirSync(join(probe, "target"));
    symlinkSync(join(probe, "target"), join(probe, "link"), "junction");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!CAN_JUNCTION)(
  "read_file refuses a path under a directory link that escapes",
  async () => {
    const outside = mkdtempSync(join(tmpdir(), "kuang-outside-"));
    writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY", "utf-8");

    const root = sandbox();
    symlinkSync(outside, join(root, "vendor"), "junction");

    await expect(tool(root, "read_file").run({ path: "vendor/id_rsa" })).rejects.toThrow(/link/i);
  },
);

test.skipIf(!CAN_JUNCTION)(
  "write_file refuses to create a file under an escaping directory link",
  async () => {
    const outside = mkdtempSync(join(tmpdir(), "kuang-outside-"));
    const root = sandbox();
    symlinkSync(outside, join(root, "vendor"), "junction");

    // The target does not exist, so this also covers the nearest-ancestor path.
    await expect(
      tool(root, "write_file").run({ path: "vendor/planted.sh", content: "rm -rf /" }),
    ).rejects.toThrow(/link/i);
    expect(existsSync(join(outside, "planted.sh"))).toBe(false);
  },
);
