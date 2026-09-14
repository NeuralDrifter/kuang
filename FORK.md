# Fork notes

Kuang 匡 is an independent fork of [bailian-cli](https://github.com/modelstudioai/cli)
by Aliyun Model Studio, licensed under Apache-2.0.

Not affiliated with, endorsed by, or supported by Alibaba. "Aliyun", "Bailian",
"Model Studio" and "DashScope" are trademarks of their respective owners and are
used here only descriptively.

This file records divergence from upstream, as required by Apache-2.0 §4(b).

## Identity

|         | Upstream        | Kuang         |
| ------- | --------------- | ------------- |
| Binary  | `bl`, `bailian` | `kuang`       |
| Package | `bailian-cli`   | `bailian-cli` |
| Version | 1.24.0          | 1.24.0        |

Internal libraries (`bailian-cli-core`, `bailian-cli-runtime`,
`bailian-cli-commands`, `knowledge-studio-cli`) keep their upstream names. They
are workspace-linked and never installed standalone.

## Changes

- **Interactive agent** (`packages/agent`) — a terminal agent UI with a local
  tool surface. Upstream ships skills _for other agents_ and no host of its own.
- **`Settings.language`** — resolved once in `buildSettings` so commands can
  localize runtime output. Upstream translates command metadata only.
- **Redaction** (`packages/agent/src/core/redact`) — secrets and personal data
  replaced with placeholders at the request boundary and restored on the way
  out, driven by `--redact` and `/pii`. Upstream has no equivalent.
- **Hermes Agent support removed** — upstream's `config agent hermes` writer,
  its inventory entry, its `HERMES_HOME` skill target and its tests are gone.
  It also carried a `platform() === "win32"` warning telling Windows users that
  Hermes needs WSL2; that has not been true since Hermes gained native Windows
  support, so the warning would have been wrong to keep either way. The other
  five agents (`claude-code`, `qwen-code`, `opencode`, `openclaw`, `codex`) are
  untouched. This is a deliberate narrowing, not a bug fix — the upstream
  `CHANGELOG` entries that mention Hermes are left alone, because they record
  what upstream shipped.
