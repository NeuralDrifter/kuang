// SPDX-License-Identifier: Apache-2.0
// Modified 2026 by Michael P. Burgus <https://github.com/NeuralDrifter>
// Original: bailian-cli, Copyright 2026 Aliyun Model Studio (DashScope) AI Platform

import { defineCommand } from "bailian-cli-core";
import { runAgent } from "kuang-agent";

export default defineCommand({
  description: {
    "en-US": "Launch the interactive agent",
    "zh-CN": "启动交互式 Agent",
  },
  auth: "apiKey",
  usageArgs: "[flags]",
  flags: {},
  async run(ctx) {
    await runAgent(ctx);
  },
});
