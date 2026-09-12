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
    // US SSN
    /\b\d{3}-\d{2}-\d{4}\b/g,
    // Credit Cards (simplified 13-16 digits)
    /\b(?:\d[ -]*?){13,16}\b/g,
    // Chinese Resident Identity Card (18 digits)
    /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    // Chinese Mobile Phone Number (11 digits starting with 13-19)
    /\b1[3-9]\d{9}\b/g,
    // Singapore NRIC / FIN
    /\b[STFGMstfgm]\d{7}[a-zA-Z]\b/g,
    // Singapore Mobile Phone Numbers (8 digits starting with 8 or 9, optional +65)
    /\b(?:\+?65[ -]?)?[89]\d{7}\b/g,
    // Canadian Social Insurance Number (SIN) (9 digits, e.g., 123-456-789)
    /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g,
    // Canadian Passport Number (2 letters + 6 digits)
    /\b[A-Za-z]{2}\d{6}\b/g,
    // North American (US/Canada) Phone Numbers
    /\b(?:\+?1[-. ]?)?\(?[2-9]\d{2}\)?[-. ]?[2-9]\d{2}[-. ]?\d{4}\b/g,
    // European IBAN (International Bank Account Number)
    /\b[A-Za-z]{2}\d{2}[ -]?[A-Za-z0-9]{4,30}\b/g,
    // UK National Insurance Number (NINO)
    /\b[A-Za-z]{2}[ -]?\d{2}[ -]?\d{2}[ -]?\d{2}[ -]?[A-Za-z]\b/g,
    // French Social Security Number (NIR)
    /\b[12][ -]?\d{2}[ -]?\d{2}[ -]?\d{2}[ -]?\d{3}[ -]?\d{3}[ -]?\d{2}\b/g,
    // EU VAT Number
    /\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[ -]?[A-Z0-9]{2,13}\b/gi,
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

class StreamRestorer {
  private buffer = "";
  private vault: RedactionVault;
  
  constructor(vault: RedactionVault) {
    this.vault = vault;
  }
  
  push(chunk: string): string {
    this.buffer += chunk;
    this.buffer = this.vault.restore(this.buffer);
    
    let safeToFlush = "";
    const lastOpen = this.buffer.lastIndexOf('[');
    if (lastOpen === -1) {
       safeToFlush = this.buffer;
       this.buffer = "";
    } else {
       const suffix = this.buffer.slice(lastOpen);
       if ("[REDACTED_PII_".startsWith(suffix) || /^\[REDACTED_PII_\d*$/.test(suffix)) {
          safeToFlush = this.buffer.slice(0, lastOpen);
          this.buffer = suffix;
       } else {
          safeToFlush = this.buffer;
          this.buffer = "";
       }
    }
    return safeToFlush;
  }
  
  flush(): string {
    const res = this.vault.restore(this.buffer);
    this.buffer = "";
    return res;
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
        content: isZH ? "您是一个运行在本地终端中的 AI Agent。您拥有读取文件和运行 Bash 命令的工具。请帮助用户完成他们的任务。注意：用户的敏感数据会被替换为 [REDACTED_PII_x] 的形式。您可以正常阅读和使用这些占位符，只需将占位符原样返回，系统会自动为您替换回真实数据以供执行和显示。" : "You are a helpful AI Agent running in a local terminal. You have tools to read files and run bash commands. Help the user with their tasks. NOTE: Sensitive data is replaced with placeholders like [REDACTED_PII_1]. You can read and use these placeholders normally. Just output the placeholder exactly as is, and the system will seamlessly restore the real data for execution and display.",
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
      const inputStr = String(input).trim();

      if (inputStr.startsWith("/apikey ")) {
        const newKey = inputStr.substring(8).trim();
        try {
           execSync(`npx tsx packages/cli/src/main.ts config set --key api_key --value "${newKey}"`, { stdio: 'ignore' });
           note(isZH ? "API Key 已保存。请重启 Agent (/exit) 以生效。" : "API Key saved. Please restart the agent (/exit) for changes to take effect.", "Success");
        } catch (e) {
           note(isZH ? "保存 API Key 失败。" : "Failed to save API Key.", "Error");
        }
        continue;
      }

      if (inputStr.startsWith("/url ")) {
        const newUrl = inputStr.substring(5).trim();
        try {
           execSync(`npx tsx packages/cli/src/main.ts config set --key base_url --value "${newUrl}"`, { stdio: 'ignore' });
           note(isZH ? "Base URL 已保存。请重启 Agent (/exit) 以生效。" : "Base URL saved. Please restart the agent (/exit) for changes to take effect.", "Success");
        } catch (e) {
           note(isZH ? "保存 Base URL 失败。" : "Failed to save Base URL.", "Error");
        }
        continue;
      }

      messages.push({ role: "user", content: vault.sanitize(inputStr) });

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
        const restorer = new StreamRestorer(vault);

        for await (const event of parseSSE(responseStream)) {
          if (event.data === "[DONE]") break;
          try {
            const parsed = JSON.parse(event.data);
            for (const choice of parsed.choices) {
              const delta = choice.delta;

              if (delta.content) {
                textContent += delta.content;
                process.stdout.write(pc.white(restorer.push(delta.content)));
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
        
        const remaining = restorer.flush();
        if (remaining) {
           process.stdout.write(pc.white(remaining));
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
