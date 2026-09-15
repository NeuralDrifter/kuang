// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The store. Every test here is about a failure path — the happy path is one
 * line of JSON.parse and would not be worth a file of its own.
 */
import { expect, test } from "vite-plus/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../src/core/store.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "kuang-store-"));
}

test("a value written is a value read back", () => {
  const path = join(dir(), "a.json");
  writeJson(path, { hello: "world", n: 1 });
  expect(readJson(path, undefined)).toEqual({ hello: "world", n: 1 });
});

test("a missing file returns the fallback rather than throwing", () => {
  // The first run of anything is this case.
  expect(readJson(join(dir(), "absent.json"), { rules: [] })).toEqual({ rules: [] });
});

test("parent directories are created", () => {
  const path = join(dir(), "agent", "sessions", "s1.json");
  writeJson(path, { id: "s1" });
  expect(readJson(path, undefined)).toEqual({ id: "s1" });
});

test("a malformed file is quarantined and does not stop the caller", () => {
  const d = dir();
  const path = join(d, "approvals.json");
  writeFileSync(path, "{ this is not json", "utf-8");

  // Refusing to launch over yesterday's approvals would be the worse failure.
  expect(readJson(path, { rules: [] })).toEqual({ rules: [] });

  const quarantined = readdirSync(d).filter((f) => f.includes(".corrupt-"));
  expect(quarantined).toHaveLength(1);
  // Moved aside, not destroyed: it may be the only copy of something wanted.
  expect(readFileSync(join(d, quarantined[0]!), "utf-8")).toBe("{ this is not json");
});

test("a quarantined file is out of the way, so the next write succeeds", () => {
  const path = join(dir(), "approvals.json");
  writeFileSync(path, "garbage", "utf-8");
  readJson(path, {});

  writeJson(path, { rules: ["ok"] });
  expect(readJson(path, undefined)).toEqual({ rules: ["ok"] });
});

test("a directory where a file should be is survived", () => {
  const d = dir();
  const path = join(d, "weird.json");
  mkdirSync(path);

  // Unreadable for a reason that is not corruption: do not move it, do not throw.
  expect(readJson(path, { fallback: true })).toEqual({ fallback: true });
  expect(statSync(path).isDirectory()).toBe(true);
});

test("a failed write leaves the previous contents intact", () => {
  const path = join(dir(), "a.json");
  writeJson(path, { version: 1 });

  // A value JSON.stringify refuses: the temp file is never renamed over.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => writeJson(path, circular)).toThrow();

  expect(readJson(path, undefined)).toEqual({ version: 1 });
});

test("a failed write leaves no temp file behind", () => {
  const d = dir();
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  expect(() => writeJson(join(d, "a.json"), circular)).toThrow();
  expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
});

test("writing over an existing file replaces it completely", () => {
  const path = join(dir(), "a.json");
  writeJson(path, { a: 1, b: 2, c: 3 });
  writeJson(path, { a: 9 });

  // Rename, not truncate-and-write: no remnant of the longer previous value.
  expect(readJson(path, undefined)).toEqual({ a: 9 });
  expect(readFileSync(path, "utf-8")).not.toContain("b");
});

test("no temp file survives a successful write", () => {
  const d = dir();
  writeJson(join(d, "a.json"), { ok: true });
  expect(readdirSync(d)).toEqual(["a.json"]);
});

test.skipIf(platform() === "win32")("files are written owner-only", () => {
  const path = join(dir(), "secret.json");
  writeJson(path, { token: "x" });

  // Windows ignores POSIX modes; asserting there would test nothing.
  expect(statSync(path).mode & 0o077).toBe(0);
});

test("the file ends with a newline", () => {
  const path = join(dir(), "a.json");
  writeJson(path, { a: 1 });
  // So it reads correctly in a terminal and diffs cleanly if committed.
  expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true);
});

test("an empty file is treated as absent, not as a crash", () => {
  const path = join(dir(), "a.json");
  writeFileSync(path, "", "utf-8");
  // A zero-byte file is the classic result of a disk filling up mid-write.
  expect(readJson(path, { rules: [] })).toEqual({ rules: [] });
  expect(existsSync(path)).toBe(false);
});
