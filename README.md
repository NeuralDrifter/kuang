<div align="center">

# Kuang 匡

**An interactive coding and media agent for Aliyun Model Studio**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

[中文](README.zh.md) · [What diverged from upstream](FORK.md)

</div>

> **Kuang 匡 is an independent fork of [bailian-cli](https://github.com/modelstudioai/cli)**, the
> Aliyun Model Studio CLI. It is **not** official, and is not affiliated with,
> endorsed by, or supported by Alibaba. For the official tool, go upstream.
>
> 匡 (kuāng) — to correct, to rectify, to assist. 匡正, 匡扶.

---

## What this is

The upstream CLI ships **skills for other people's agents** — it detects Claude
Code, Cline, Warp, Zed and friends, and installs instruction packs into their
directories. It has 228 commands covering text, image, video, speech, knowledge
bases, fine-tuning and deployment. What it never had was an agent of its own.

Kuang is that missing piece: a terminal agent, in the class of Claude Code or
Gemini CLI, that runs **on top of** those 228 commands instead of beside them.
The long-term goal is one interface where you can write code, generate an image,
cut a video and ship a fine-tune without leaving the prompt.

Everything the upstream CLI does still works. Kuang adds a host for it.

## Status

Early, but usable. The agent runs against the live API and can reach the whole
platform command surface. Media generation is wired and its requests are
verified; only the live media responses are untested, for want of credits.

**Working today**

- Interactive agent (`kuang agent`) — streaming replies, token accounting, clean exit
- Six local tools: `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `shell`
- **The whole platform as tools.** Seven first-class capabilities — image, video,
  speech, transcription, vision, web search, knowledge retrieval — plus
  `bl_search_commands` / `bl_describe_command` / `bl_run_command`, which reach
  all 228 upstream commands for a few hundred tokens of context instead of the
  ~60k it would cost to hand over every schema
- Tool schemas are **generated from the CLI's own flag metadata**, so they are
  bilingual for free and cannot drift from the commands they call
- Three-tier approvals: reads run silently, writes and shell ask first, with a
  unified diff shown **before** you approve, not after
- Anything that spends media credits asks first and **says so in the prompt**
- "Always allow" stores a _pattern_, not the literal command, and fails closed on
  anything it cannot safely generalise
- Shell with real interpreter selection (pwsh / powershell / bash / python /
  python3), probed at startup — no more assuming `bash` on Windows
- Every path resolved against the project root and refused if it escapes
- 140 tests — 135 headless unit tests plus 5 that drive the real CLI

**Wired but not verified against the live API**

Image, video and speech generation are implemented and their request
construction is tested end-to-end against the real CLI with `--dry-run`, which
builds and prints the exact request without calling the API. What has **not**
been exercised is the live response: the account's media credits are exhausted
and do not renew.

Two bugs were already caught this way and fixed — `--download` needs a path
rather than being a switch, and `speech synthesize` requires a voice. There may
be more that only a real response would reveal. Treat these three as untested.

**Not yet**

- Session persistence and `--resume`
- Ink-based TUI — the current renderer is plain text
- Full bilingual coverage — UI labels and tool descriptions are localized,
  some payload strings are not yet
- Skills as a knowledge layer
- PII redaction (the inherited prototype's version was removed; see FORK.md)

## Install

Not published to any registry. Build from source:

```bash
git clone https://github.com/NeuralDrifter/kuang.git
cd kuang
pnpm install
```

Run it directly:

```bash
cd packages/cli && npx tsx src/main.ts agent
```

Or link a real `kuang` binary onto your PATH:

```bash
pnpm -F bailian-cli build
cd packages/cli && npm link
kuang agent
```

> Requires Node.js >= 18.17. The binary is `kuang`, **not** `bl` — that name
> belongs to the upstream CLI and the two would collide on your PATH.

## Authentication

Inherited from upstream and unchanged. An API key is the simplest path:

```bash
kuang auth login
```

Or set it directly:

```bash
kuang config set --key api_key --value sk-...
```

Console OAuth (`kuang auth login --console`) and Alibaba Cloud AK/SK
(`kuang auth login --open-api`) also work. Config lives at
`~/.bailian/config.json`.

## Using the agent

```
$ kuang agent
> what does the approval gate do when a command chains with &&?
```

Reads, globs and greps run without interrupting you. Writes, edits and shell
commands stop and ask:

```
Approval required: shell
  bash: pnpm test --run (in /home/you/project)
[y]es / [n]o / [a]lways:
```

Answer `a` and it remembers the _pattern_ `pnpm test*`, so `pnpm test --watch`
won't ask again — but `rm -rf /` still will. Type `/exit` or press Ctrl+D to leave.

It can also reach the platform. Ask for something it has no local tool for and
it will find the command itself:

```
> what commands are there for checking my quota?

Running: bl_search_commands({"query": "quota"})
✓ quota check — Check current usage against rate limits
  quota list  — View model rate limits (QPM/TPM, account and workspace level)
  usage free  — Query free-tier quota for models
```

Anything that spends media credits stops and tells you so first:

```
Approval required: generate_image
  image generate: a cat in a spacesuit on Mars — spends media credits
[y]es / [n]o / [a]lways:
```

## The inherited CLI

All 228 upstream commands remain available and unmodified:

```bash
kuang text chat --message "hello"
kuang image generate --prompt "a cat in a spacesuit on Mars"
kuang video generate --prompt "..." --download
kuang knowledge retrieve --index-id ... --query "..."
kuang usage
```

`kuang <command> --help` for any of them. Upstream's own documentation applies —
only the binary name changed.

## Security

The agent runs commands a language model proposed, on your machine. Two known
limitations, both deliberate and both tracked:

1. **Approval patterns generalise by command prefix.** A rule derived from
   `rm -f build/tmp.txt` also permits `rm -f -r /`. Contained today only because
   approvals are in-memory per session and never persisted. A denylist of
   never-generalisable commands must land _with_ persistence, not after it.
2. **Symlinks are followed.** `read_file` runs without approval and does not call
   `realpath`, so a symlink inside a repository can point outside it.

Do not run this against a repository you do not trust.

Every known bug, gap and untested area is written down in
[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture and conventions are in
[AGENTS.md](AGENTS.md); the agent package layers as `core/` (pure, no I/O) and
`ui/` (renderers), and `core/` must never import `ui/`.

```bash
npx vp check --fix                        # lint + types
cd packages/agent && npx vp test --run    # agent tests
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Original work © 2026 Aliyun Model Studio (DashScope) AI Platform.
Modifications © 2026 Michael P. Burgus.

"Aliyun", "Bailian", "Model Studio" and "DashScope" are trademarks of their
respective owners and are used here descriptively only.
