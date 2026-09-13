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
