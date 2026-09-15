// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Session records. The claim being tested is narrow and important: what
 * reaches the disk is the sanitized transcript, so a session file holds no
 * secret as a property of what was written.
 */
import { expect, test } from "vite-plus/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "../src/core/messages.ts";
import { Vault } from "../src/core/redact/vault.ts";
import {
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  recordFor,
  saveSession,
} from "../src/core/session.ts";

const CARD = "4111 1111 1111 1111";
const ROOT = "/work/repo";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "kuang-sess-"));
}

function meta(id = newSessionId()) {
  return { id, projectRoot: ROOT, model: "qwen-max", language: "en-US" as const };
}

function conversation(): AgentMessage[] {
  return [
    { role: "system", content: "you are kuang" },
    { role: "user", content: `my card is ${CARD}` },
    { role: "assistant", content: "noted", toolCalls: [] },
  ];
}

// ── the guarantee ───────────────────────────────────────────────────────────

test("a secret in the transcript never reaches the file", () => {
  const d = dir();
  const vault = new Vault();
  const record = recordFor(meta(), conversation(), vault);

  const path = join(d, `${record.id}.json`);
  saveSession(record, path);

  // Assert on the bytes, not the object: what matters is what landed on disk.
  const bytes = readFileSync(path, "utf-8");
  expect(bytes).not.toContain("4111");
  expect(bytes).toContain("REDACTED_CARD_1");
});

test("without a vault the file holds what the conversation held", () => {
  const d = dir();
  const record = recordFor(meta(), conversation());
  const path = join(d, `${record.id}.json`);
  saveSession(record, path);

  // Redaction is opt-in, and nothing was ever captured to protect. Honest
  // behaviour, and the reason the README says --redact protects sessions too.
  expect(readFileSync(path, "utf-8")).toContain("4111");
});

test("the live transcript is untouched by being saved", () => {
  const messages = conversation();
  recordFor(meta(), messages, new Vault());

  // Sanitizing must copy, not edit in place, or the running session loses the
  // values it needs to restore.
  expect(JSON.stringify(messages)).toContain("4111");
});

// ── round trip ──────────────────────────────────────────────────────────────

test("a saved session loads back", () => {
  const d = dir();
  const record = recordFor(meta("s1"), conversation());
  saveSession(record, join(d, "s1.json"));

  expect(loadSession("s1", join(d, "s1.json"))).toEqual(record);
});

test("a missing session is undefined, not an error", () => {
  expect(loadSession("nope", join(dir(), "nope.json"))).toBeUndefined();
});

test("a damaged session file is undefined rather than a crash", () => {
  const path = join(dir(), "s1.json");
  writeFileSync(path, "{ broken", "utf-8");
  expect(loadSession("s1", path)).toBeUndefined();
});

test("a session from an unknown version is not guessed at", () => {
  const path = join(dir(), "s1.json");
  writeFileSync(path, JSON.stringify({ version: 99, id: "s1", messages: [] }), "utf-8");
  expect(loadSession("s1", path)).toBeUndefined();
});

test("createdAt survives an update but updatedAt moves", () => {
  const first = recordFor(meta("s1"), conversation(), undefined, new Date("2026-01-01T00:00:00Z"));
  const second = recordFor(
    { ...meta("s1"), createdAt: first.createdAt },
    conversation(),
    undefined,
    new Date("2026-01-02T00:00:00Z"),
  );

  expect(second.createdAt).toBe(first.createdAt);
  expect(second.updatedAt).not.toBe(first.updatedAt);
});

// ── listing ─────────────────────────────────────────────────────────────────

test("sessions are listed newest first", () => {
  const d = dir();
  for (const [id, when] of [
    ["old", "2026-01-01T00:00:00Z"],
    ["new", "2026-03-01T00:00:00Z"],
    ["mid", "2026-02-01T00:00:00Z"],
  ] as const) {
    const r = recordFor(meta(id), conversation(), undefined, new Date(when));
    saveSession(r, join(d, `${id}.json`));
  }

  expect(listSessions(ROOT, d).map((s) => s.id)).toEqual(["new", "mid", "old"]);
  expect(latestSession(ROOT, d)?.id).toBe("new");
});

test("another project's sessions are not listed", () => {
  const d = dir();
  saveSession(recordFor(meta("mine"), conversation()), join(d, "mine.json"));
  saveSession(
    recordFor({ ...meta("theirs"), projectRoot: "/work/elsewhere" }, conversation()),
    join(d, "theirs.json"),
  );

  expect(listSessions(ROOT, d).map((s) => s.id)).toEqual(["mine"]);
});

test("one damaged file does not hide the rest", () => {
  const d = dir();
  saveSession(recordFor(meta("good"), conversation()), join(d, "good.json"));
  writeFileSync(join(d, "bad.json"), "not json at all", "utf-8");

  expect(listSessions(ROOT, d).map((s) => s.id)).toEqual(["good"]);
});

test("a listing carries enough to recognise a session", () => {
  const d = dir();
  const messages: AgentMessage[] = [
    { role: "user", content: "fix the flaky test in the parser\nand explain why" },
    { role: "assistant", content: "ok", toolCalls: [] },
    { role: "user", content: "second question" },
  ];
  saveSession(recordFor(meta("s1"), messages), join(d, "s1.json"));

  const [summary] = listSessions(ROOT, d);
  expect(summary?.title).toBe("fix the flaky test in the parser");
  expect(summary?.turns).toBe(2);
});

test("a long first line is truncated rather than wrapping a listing", () => {
  const d = dir();
  const messages: AgentMessage[] = [{ role: "user", content: "x".repeat(200) }];
  saveSession(recordFor(meta("s1"), messages), join(d, "s1.json"));

  expect(listSessions(ROOT, d)[0]?.title.length).toBeLessThanOrEqual(72);
});

test("a title is drawn from the sanitized transcript", () => {
  const d = dir();
  const vault = new Vault();
  const messages: AgentMessage[] = [{ role: "user", content: `my card ${CARD} please` }];
  saveSession(recordFor(meta("s1"), messages, vault), join(d, "s1.json"));

  // A listing is printed to a terminal and may be shared in a screenshot.
  expect(listSessions(ROOT, d)[0]?.title).not.toContain("4111");
});

test("a missing sessions directory lists nothing rather than throwing", () => {
  expect(listSessions(ROOT, join(tmpdir(), "kuang-no-such-dir-98765"))).toEqual([]);
});

test("ids sort in the order the sessions were started", () => {
  const a = newSessionId(new Date("2026-01-01T00:00:00Z"));
  const b = newSessionId(new Date("2026-06-01T00:00:00Z"));
  // A directory read in name order is then already newest-last.
  expect(a < b).toBe(true);
});

test("the project root is stored resolved", () => {
  expect(recordFor(meta("s1"), []).projectRoot).toBe(resolve(ROOT));
});
