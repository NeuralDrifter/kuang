// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Apache-2.0 §4(b) requires modified files to carry a notice that they changed.
 * Upstream ships no per-file headers, so this is a fork-only rule: every file
 * under the paths we own must declare SPDX, and files we inherited and edited
 * must additionally say so.
 */

/** Lines scanned at the top of a file — a header further down is not "prominent". */
const HEAD_LINES = 10;

/** Whether `source` opens with an acceptable license header. */
export function hasValidHeader(source) {
  const head = source.split("\n", HEAD_LINES).join("\n");
  return head.includes("SPDX-License-Identifier: Apache-2.0");
}

/** Files the rule applies to. Generated output and vendored code are exempt. */
export function isCovered(path) {
  const p = path.replaceAll("\\", "/");
  if (!/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(p)) return false;
  if (p.includes("/node_modules/") || p.includes("/dist/")) return false;
  if (p.startsWith("packages/agent/") || p.startsWith("tools/")) return true;
  const explicit = [
    "packages/commands/src/commands/agent/index.ts",
    "packages/commands/src/index.ts",
    "packages/commands/tests/sandbox.test.ts",
    "packages/core/src/config/loader.ts",
    "packages/core/src/config/schema.ts",
    "packages/core/tests/image-input.test.ts",
    "packages/core/tests/index.test.ts",
    "packages/core/tests/mcp.test.ts",
  ];
  return explicit.includes(p);
}

import { readFileSync } from "node:fs";

/** CLI: `node tools/check-headers.mjs <file>...` — exits non-zero on violations. */
if (process.argv[1] && process.argv[1].endsWith("check-headers.mjs")) {
  const bad = process.argv
    .slice(2)
    .filter((f) => isCovered(f) && !hasValidHeader(readFileSync(f, "utf-8")));
  if (bad.length > 0) {
    console.error("Missing Apache-2.0 header:\n" + bad.map((f) => "  " + f).join("\n"));
    process.exitCode = 1;
  }
}
