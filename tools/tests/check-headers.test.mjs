import { expect, test } from "vite-plus/test";
import { hasValidHeader } from "../check-headers.mjs";

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
