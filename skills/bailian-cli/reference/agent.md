# `bl agent` commands

> Auto-generated from `packages/cli/src/commands.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference`.

Index: [index.md](index.md)

## Commands in this group

| Command | Authentication | Description |
| --- | --- | --- |
| `bl agent` | API Key | Launch the interactive agent |

## Command details

### `bl agent`

| Field | Value |
| --- | --- |
| **Name** | `agent` |
| **Description** | Launch the interactive agent |
| **Authentication** | API Key |
| **Usage** | `bl agent [flags]` |

#### Flags

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--redact` | switch | no | Hide secrets and personal data from the model (toggle with /pii) |
| `--continue` | switch | no | Resume the most recent conversation in this project |
| `--save-secrets` | switch | no | Keep redacted values on disk for this session, sealed with a passphrase (default: memory only). Toggle with /pii save and /pii forget |
| `--resume <id>` | string | no | Resume a conversation by id (see /sessions) |
| `--api-key <key>` | string | no | API key |
| `--base-url <url>` | string | no | API base URL |

#### Examples

_No examples._
