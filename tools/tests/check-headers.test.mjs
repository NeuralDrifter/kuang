// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { hasValidHeader, isCovered } from "../check-headers.mjs";

test("accepts the new-file header", () => {
  const src = [
    "// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>",
    "// SPDX-License-Identifier: Apache-2.0",
    "",
    "export const x = 1;",
  ].join("\n");
  expect(hasValidHeader(src)).toBe(true);
});

test("accepts the modified-file notice", () => {
  const src = [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Modified 2026 by Michael P. Burgus <https://github.com/NeuralDrifter>",
    "// Original: bailian-cli, Copyright 2026 Aliyun Model Studio (DashScope) AI Platform",
    "",
    "export const x = 1;",
  ].join("\n");
  expect(hasValidHeader(src)).toBe(true);
});

test("rejects a file with no SPDX identifier", () => {
  expect(hasValidHeader("export const x = 1;\n")).toBe(false);
});

test("only inspects the head of the file", () => {
  const src = "export const x = 1;\n".repeat(40) + "// SPDX-License-Identifier: Apache-2.0\n";
  expect(hasValidHeader(src)).toBe(false);
});

test("covers the files this fork wrote", () => {
  expect(isCovered("packages/agent/src/ui/ink/app.tsx")).toBe(true);
  expect(isCovered("tools/check-headers.mjs")).toBe(true);
  expect(isCovered("tools/tests/check-headers.test.mjs")).toBe(true);
});

test("covers inherited files this fork has modified", () => {
  // Apache-2.0 §4(b) attaches to files we changed, so these are listed by name.
  expect(isCovered("packages/core/src/config/schema.ts")).toBe(true);
});

test("does not claim upstream's own files", () => {
  // `tools/` was covered wholesale, so an upstream file landing there was
  // asked for a copyright line this fork has no right to add. It first bit
  // when upstream added binary-release.mjs and oss-direct-upload.mjs, and the
  // merge could not be committed.
  expect(isCovered("tools/release/lib/binary-release.mjs")).toBe(false);
  expect(isCovered("tools/release/lib/oss-direct-upload.mjs")).toBe(false);
  expect(isCovered("tools/generate-reference.ts")).toBe(false);
  expect(isCovered("packages/core/src/client/index.ts")).toBe(false);
});

test("ignores generated output and vendored code", () => {
  expect(isCovered("packages/agent/dist/index.js")).toBe(false);
  expect(isCovered("packages/agent/node_modules/x/index.js")).toBe(false);
  expect(isCovered("packages/agent/README.md")).toBe(false);
});
