<div align="center">

# Kuang 匡

**面向阿里云百炼的交互式编程与多媒体 Agent**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

[English](README.md) · [与上游的差异](FORK.md)

</div>

> **Kuang 匡 是 [bailian-cli](https://github.com/modelstudioai/cli)（阿里云百炼 CLI）的独立 fork 项目。**
> 本项目**并非官方产品**，与阿里巴巴无隶属关系，未获其认可，也不由其提供支持。
> 如需官方工具，请前往上游仓库。
>
> 匡（kuāng）——匡正、匡扶，意为纠正与辅助。

---

## 这是什么

上游 CLI 提供的是**给别人的 Agent 用的技能包**：它会检测 Claude Code、Cline、
Warp、Zed 等工具，并把指令包安装到它们的目录里。它有 228 条命令，覆盖文本、
图片、视频、语音、知识库、模型精调与部署。唯独没有的，是它自己的 Agent。

Kuang 补的就是这一块：一个终端 Agent，定位与 Claude Code、Gemini CLI 同类，
但它**运行在这 228 条命令之上**，而不是与之并列。长期目标是在同一个界面里
写代码、生成图片、剪视频、上线精调模型，全程不用离开命令行。

上游 CLI 原有的能力全部保留，Kuang 只是为它补上了宿主。

## 当前状态

尚处早期。Agent 内核已完成、已测试，并已对接线上 API 验证通过。让它能真正
生成多媒体的平台工具层，是下一步的工作。

**已经可用**

- 交互式 Agent（`kuang agent`）——流式回复、Token 统计、干净退出
- 六个本地工具：`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`shell`
- 三级审批：读取静默执行，写入与 shell 先行询问，并在**批准之前**展示 unified diff，而非事后
- 「始终允许」保存的是**模式**而非原始命令；任何无法安全泛化的调用一律拒绝（fail-closed）
- shell 支持真实的解释器选择（pwsh / powershell / bash / python / python3），启动时探测——不再默认 Windows 上有 bash
- 所有路径都相对项目根目录解析，越界一律拒绝
- 10 个文件共 77 项测试，全部无头运行——Agent 内核无需终端即可测试

**尚未完成**

- 把 228 条 `bl` 命令接成 Agent 工具（图片、视频、语音、知识库、精调）
- 会话持久化与 `--resume`
- 基于 Ink 的 TUI——当前渲染器是纯文本
- 完整双语覆盖——界面标签已本地化，内容字符串尚未
- 将 skills 作为知识层接入
- PII 脱敏（继承自原型的实现已移除，原因见 FORK.md）

## 安装

尚未发布到任何 registry，请从源码构建：

```bash
git clone https://github.com/NeuralDrifter/kuang.git
cd kuang
pnpm install
```

直接运行：

```bash
cd packages/cli && npx tsx src/main.ts agent
```

或链接出真正的 `kuang` 可执行文件：

```bash
pnpm -F bailian-cli build
cd packages/cli && npm link
kuang agent
```

> 需要 Node.js >= 18.17。可执行文件名是 `kuang`，**不是** `bl`——后者属于上游
> CLI，两者会在 PATH 上冲突。

## 认证

沿用上游实现，未做改动。最简单的方式是使用 API Key：

```bash
kuang auth login
```

也可以直接写入：

```bash
kuang config set --key api_key --value sk-...
```

控制台 OAuth（`kuang auth login --console`）与阿里云 AK/SK
（`kuang auth login --open-api`）同样可用。配置文件位于 `~/.bailian/config.json`。

## 使用 Agent

```
$ kuang agent
> 审批闸门遇到用 && 串接的命令会怎么处理？
```

读取、glob、grep 不会打断你；写入、编辑与 shell 命令会停下来询问：

```
需要批准：shell
  bash: pnpm test --run（位于 /home/you/project）
[y]是 / [n]否 / [a]始终允许：
```

回答 `a` 之后，它记住的是模式 `pnpm test*`，所以 `pnpm test --watch` 不会再问，
但 `rm -rf /` 仍然会。输入 `/exit` 或按 Ctrl+D 退出。

## 继承的 CLI

上游的 228 条命令全部保留、未作修改：

```bash
kuang text chat --message "你好"
kuang image generate --prompt "太空服里的猫，火星背景"
kuang video generate --prompt "..." --download
kuang knowledge retrieve --index-id ... --query "..."
kuang usage
```

任何命令都可以用 `kuang <command> --help` 查看帮助。上游文档同样适用——
变的只有可执行文件名。

## 安全说明

这个 Agent 会在你的机器上执行由大模型提出的命令。有两处已知限制，均为有意
保留并已记录在案：

1. **审批模式按命令前缀泛化。** 由 `rm -f build/tmp.txt` 推导出的规则同样允许
   `rm -f -r /`。目前之所以可控，仅仅因为审批只存在于单次会话内存中、不落盘。
   永不泛化命令的黑名单必须与持久化**同一次**落地，不能滞后。
2. **符号链接会被跟随。** `read_file` 无需审批即可执行，且未调用 `realpath`，
   因此仓库内的符号链接可以指向仓库之外。

请不要在你不信任的仓库上运行它。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。架构与约定见 [AGENTS.md](AGENTS.md)。
agent 包分为 `core/`（纯逻辑，无 I/O）与 `ui/`（渲染层），且 `core/` 永远不得
引用 `ui/`。

```bash
npx vp check --fix                        # lint 与类型检查
cd packages/agent && npx vp test --run    # agent 测试
```

## 许可

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

原始作品 © 2026 Aliyun Model Studio (DashScope) AI Platform。
修改部分 © 2026 Michael P. Burgus。

「Aliyun」「Bailian」「Model Studio」「DashScope」为各自权利人的商标，
此处仅作描述性使用。
