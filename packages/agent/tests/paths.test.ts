// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "vite-plus/test";
import { join } from "node:path";
import { agentDir, approvalsPath, sessionPath, sessionsDir } from "../src/core/paths.ts";

const previous = process.env.BAILIAN_CONFIG_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.BAILIAN_CONFIG_DIR;
  else process.env.BAILIAN_CONFIG_DIR = previous;
});

test("BAILIAN_CONFIG_DIR relocates everything the agent persists", () => {
  process.env.BAILIAN_CONFIG_DIR = join("/tmp", "somewhere-else");

  // One variable has to move all of it, or a user who redirects the CLI's
  // config still leaks agent state into their home directory.
  expect(agentDir()).toBe(join("/tmp", "somewhere-else", "agent"));
  expect(approvalsPath()).toBe(join("/tmp", "somewhere-else", "agent", "approvals.json"));
  expect(sessionsDir()).toBe(join("/tmp", "somewhere-else", "agent", "sessions"));
});

test("everything lives under the agent directory", () => {
  process.env.BAILIAN_CONFIG_DIR = join("/tmp", "cfg");
  const root = agentDir();

  for (const path of [approvalsPath(), sessionsDir(), sessionPath("abc")]) {
    expect(path.startsWith(root)).toBe(true);
  }
});

test("a session id becomes a json file named after it", () => {
  process.env.BAILIAN_CONFIG_DIR = join("/tmp", "cfg");
  expect(sessionPath("01HQ")).toBe(join("/tmp", "cfg", "agent", "sessions", "01HQ.json"));
});
