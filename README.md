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
- **Redaction** (`--redact`) — secrets and personal data replaced with
  placeholders on the way to the model and put back on the way out, so the
  model can work with them without ever reading them
- Bilingual slash commands — `/help` · `/帮助`, `/pii` · `/脱敏`, `/sessions` · `/会话`, `/exit` · `/退出`
- **Sessions and approvals persist** — `--continue`, `--resume <id>`, and
  "always allow" answers that outlive the terminal, scoped per project
- Optional passphrase-sealed vault (`--save-secrets`) — off by default, because
  the vault living only in memory is the promise the rest of the design rests on
- 232 tests — 227 headless unit tests plus 5 that drive the real CLI

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

- Ink-based TUI — the current renderer is plain text
- Full bilingual coverage — UI labels and tool descriptions are localized,
  some payload strings are not yet
- Skills as a knowledge layer

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

Paste as much as you like. Lines that arrive together are read as one message,
so a stack trace or a diff goes to the model whole and costs one turn rather
than one per line.

Conversations survive a restart. The transcript is written after each turn —
not at exit, since the usual way a session ends is a crash or a closed
terminal:

```bash
kuang agent --continue          # pick up the most recent one here
kuang agent --resume <id>       # a particular one
```

`/sessions` · `/会话` lists this project's conversations, newest first, marking
the one you are in. Sessions are filed per project, so a listing never mixes
two repositories.

**A session file holds the redacted transcript, not the live one.** The model
only ever saw the redacted view, so resuming loses nothing it needs — and the
file contains no secret as a property of what was written, rather than as a
promise about a permission bit. The exception is honest: with `--redact` off
nothing was ever captured, so the file holds whatever the conversation held.
Redaction protects your session files too.

**The vault lives in memory and dies with the session.** That is the default
and it does not change unless you say so. A placeholder issued before a restart
therefore cannot be turned back into its value: it stays visible as
`[REDACTED_CARD_1]` in the history, and any tool asked to write one is refused
rather than writing the placeholder text into a real file.

If you would rather keep them, `--save-secrets` seals the vault beside the
session with a passphrase — scrypt to derive the key, AES-256-GCM to seal it,
both from Node's own crypto, no dependency added. The passphrase is asked for
when saving and again when resuming, is never written down, and nothing is
echoed as you type it:

```
$ kuang agent --redact --save-secrets
Passphrase (nothing is shown as you type):
```

`/pii save` and `/pii forget` turn it on and off mid-conversation; forgetting
deletes the sealed file outright. `/pii` always says which state you are in.

Getting the passphrase wrong is not fatal — the conversation resumes without
the vault, and the placeholders simply stay as text. A wrong passphrase and an
altered file report the same thing on purpose: telling them apart would confirm
a guess to anyone probing.

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

## Keeping secrets out of the model

Start the agent with `--redact` and sensitive values are replaced before the
request leaves your machine:

```
$ kuang agent --redact
> the test account is mike@realdomain.co.uk, card 4111 1111 1111 1111

⚠ Withheld from the model: 1 CARD, 1 EMAIL
```

The model sees `[REDACTED_CARD_1]` and `[REDACTED_EMAIL_1]`. It can still count
them, group them, tell them apart and refer back to them in a later turn — the
placeholder for a given value is stable for the session — it simply cannot read
what is inside. When it writes one back, into a reply or into a tool argument,
the real value is restored first. So it can put your card number in a file it
cannot see the digits of.

Redaction happens at exactly one place, on the request itself, which means it
covers everything: what you typed, what `read_file` returned, what `shell`
printed, what any of the 228 platform commands sent back. A tool cannot leak by
being forgotten, because no tool is individually responsible.

Toggle it mid-session, and ask what it covers:

```
> /pii off
> /pii on
> /pii list
```

**Covered:** private keys · API tokens (OpenAI, GitHub, AWS, Slack, Google) ·
payment cards · IBAN accounts · Chinese resident ID · French NIR · Singapore
NRIC · US SSN · Canadian SIN · UK NINO · EU VAT · Chinese mobile numbers · North
American phone numbers · email addresses.

Where a checksum exists it has to pass — Luhn for cards and SIN, ISO 7064 for
IBAN and Chinese ID, the weighted check for NRIC — so a random 16-digit number
is not mistaken for a card. Tokens have to clear an entropy floor, so
`sk-xxxxxxxxxxxxxxxx` in documentation is left alone.

**It is best effort, and it is off by default.** A false positive costs nothing
you will notice, since the value is restored anyway. A false negative is a
secret the model read. Formats with no checksum lean on their surroundings and
can be missed, and a credential in a shape nobody has written a rule for will
pass straight through. Use it as a seatbelt, not as a guarantee — and if
something must never reach a third party, do not put it in front of an agent.

One thing to know: the redaction applies to the request, not to the transcript
the agent keeps in memory, which holds the real values so restoration has
something to restore. Nothing writes that transcript to disk today. Session
persistence will have to decide what to do about it, and that decision is
tracked rather than assumed.

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

The agent runs commands a language model proposed, on your machine.

**"Always allow" stores a pattern, and the pattern has to name a verb.**
`pnpm test` remembers `pnpm test*`; `rm -f build/tmp.txt` remembers nothing,
because a pattern ending in an option says which program runs and nothing about
what it does — which is how `rm -f*` used to equal the pattern for `rm -f -r /`.
Destructive and privilege-changing programs (`rm`, `dd`, `mv`, `chmod`,
`shutdown`, `sudo`, …) never produce a rule at all, so they ask every time.
Anything that could chain into a second command is refused outright.

A rule that names a verb still covers the tail after it: approving
`npm run build` permits `npm run <any script>`. That is the feature working —
but know that it is what you are agreeing to.

Path containment resolves symlinks: `../`, absolute paths, and links or
junctions pointing out of the project are all refused, on the project root as
well as the target, so a checkout reached through a link still works. Links
that stay inside the project resolve normally.

`--redact` reduces what a model sees, but it is a filter, not a boundary — see
above for what it does and does not promise.

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
