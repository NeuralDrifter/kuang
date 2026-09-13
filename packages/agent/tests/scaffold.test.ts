// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { runAgent } from "../src/index.ts";

test("runAgent is exported and callable", () => {
  expect(typeof runAgent).toBe("function");
});
