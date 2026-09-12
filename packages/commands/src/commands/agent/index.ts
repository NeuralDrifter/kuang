import {
  defineCommand,
  chatPath,
  parseSSE,
  type ChatRequest,
  type ChatMessage,
} from "bailian-cli-core";
import { text, intro, outro, spinner, note } from "@clack/prompts";
import pc from "picocolors";
import { readFileSync } from "fs";
import { execSync } from "child_process";

// Removed marked for now
// Configure marked to use terminal renderer

class RedactionVault {
  private secretToPlaceholder = new Map<string, string>();
  private placeholderToSecret = new Map<string, string>();
  private counter = 1;

  private rules = [
    // Typical API Keys (sk-[letters/numbers])
    /(sk-[a-zA-Z0-9]{20,})/g,
    // SSN
    /\b\d{3}-\d{2}-\d{4}\b/g,
    // Credit Cards (simplified 13-16 digits)
    /\b(?:\d[ -]*?){13,16}\b/g,
  ];

  sanitize(text: string): string {
    let sanitized = text;
    for (const rule of this.rules) {
      sanitized = sanitized.replace(rule, (match) => {
        if (!this.secretToPlaceholder.has(match)) {
          const ph = `[REDACTED_PII_${this.counter++}]`;
          this.secretToPlaceholder.set(match, ph);
          this.placeholderToSecret.set(ph, match);
        }
        return this.secretToPlaceholder.get(match)!;
      });
    }
    return sanitized;
  }

  restore(text: string): string {
    let restored = text;
    for (const [ph, secret] of this.placeholderToSecret.entries()) {
      restored = restored.split(ph).join(secret);
    }
    return restored;
  }
}

// We'll define two simple bash tools for local system access
const localTools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a local file",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute or relative file path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_bash",
      description: "Execute a bash command on the local system and return the output",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The bash command to run" } },
        required: ["command"],
      },
    },
  },
];

export default defineCommand({
  description: {
    "en-US": "Launch the Interactive AI Agent",
    "zh-CN": "启动交互式 AI Agent",
  },
  auth: "apiKey",
  usageArgs: "[flags]",
  flags: {},
  async run(ctx) {
    const { settings } = ctx;

    const isZH = settings.language === "zh-CN";

    console.clear();
    intro(pc.bgBlue(pc.white(isZH ? " Bailian CLI : 交互式 Agent " : " Bailian CLI : Interactive Agent ")));

    note(isZH ? "输入您的消息。输入 /exit 退出。" : "Type your message. Type /exit to quit.", isZH ? "欢迎！" : "Welcome!");

    const vault = new RedactionVault();

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: isZH ? "您是一个运行在本地终端中的 AI Agent。您拥有读取文件和运行 Bash 命令的工具。请帮助用户完成他们的任务。您可以自由地使用 Markdown 格式化您的输出。" : "You are a helpful AI Agent running in a local terminal. You have tools to read files and run bash commands. Help the user with their tasks. Feel free to use markdown to format your output.",
      },
    ];

    while (true) {
      const input = await text({
        message: pc.cyan(isZH ? "您：" : "You:"),
        placeholder: isZH ? "您想做什么？" : "What would you like to do?",
      });

      if (input === "/exit" || typeof input === "symbol") {
        outro(isZH ? "再见！" : "Goodbye!");
        break;
      }

      messages.push({ role: "user", content: vault.sanitize(String(input)) });

      let requireAnotherTurn = true;

      while (requireAnotherTurn) {
        requireAnotherTurn = false;
        const s = spinner();
        s.start(pc.magenta(isZH ? "Bailian 正在思考..." : "Bailian is thinking..."));

        const body: ChatRequest = {
          model: settings.defaultTextModel || "qwen-max",
          messages,
          tools: localTools as any,
          stream: true,
        };

        const responseStream = await ctx.client.request({
          path: chatPath(),
          method: "POST",
          body,
          stream: true,
        });

        s.stop(pc.magenta("◆ Bailian:"));

        let textContent = "";
        let functionCalls: Record<number, any> = {};

        for await (const event of parseSSE(responseStream)) {
          if (event.data === "[DONE]") break;
          try {
            const parsed = JSON.parse(event.data);
            for (const choice of parsed.choices) {
              const delta = choice.delta;

              if (delta.content) {
                textContent += delta.content;
                // For simplicity, we just stream raw text.
                // Full markdown rendering of a stream is complex!
                process.stdout.write(pc.white(delta.content));
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!functionCalls[tc.index]) {
                    functionCalls[tc.index] = {
                      id: tc.id,
                      type: tc.type,
                      function: { name: tc.function.name, arguments: "" },
                    };
                  }
                  if (tc.function.arguments) {
                    functionCalls[tc.index].function.arguments += tc.function.arguments;
                  }
                }
              }
            }
          } catch {}
        }

        console.log("\n");

        if (textContent) {
          messages.push({ role: "assistant", content: textContent });
        }

        const toolCallKeys = Object.keys(functionCalls);
        if (toolCallKeys.length > 0) {
          const calls = toolCallKeys.map((k) => functionCalls[Number(k)]);
          messages.push({ role: "assistant", content: "", tool_calls: calls } as any);

          for (const tc of calls) {
            const fnName = tc.function.name;
            const restoredArgsStr = vault.restore(tc.function.arguments || "{}");
            const fnArgs = JSON.parse(restoredArgsStr);

            note(pc.dim(`Tool Call: ${fnName}(${JSON.stringify(fnArgs)})`), "Executing Tool");

            let result = "";
            try {
              if (fnName === "read_file") {
                result = readFileSync(fnArgs.path, "utf-8");
              } else if (fnName === "execute_bash") {
                result = execSync(fnArgs.command, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
              } else {
                result = "Unknown tool.";
              }
            } catch (e: any) {
              result = `Error: ${e.message}`;
            }

            const sanitizedResult = vault.sanitize(result);
            const preview = sanitizedResult.length > 100 ? sanitizedResult.substring(0, 100) + "..." : sanitizedResult;
            note(pc.dim(`Result: ${preview}`), "Tool Result");
            messages.push({ role: "tool", content: sanitizedResult, tool_call_id: tc.id } as any);
          }

          // Loop again to let the model see the tool result
          requireAnotherTurn = true;
        }
      }
    }
  },
});
