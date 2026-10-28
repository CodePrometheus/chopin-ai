<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
  <img src="assets/logo.png" alt="chopin-ai" width="120">
</picture>

# chopin-ai

**A coding agent built to improve itself.**

[![npm](https://img.shields.io/npm/v/chopin-ai)](https://www.npmjs.com/package/chopin-ai)
[![License](https://img.shields.io/github/license/CodePrometheus/chopin-ai)](LICENSE)

</div>

> **Status:** `v0.2.0` is the agent. The loop that improves it is the next release; see
> [How it improves itself](#how-it-improves-itself).

## Install

```bash
npm install -g chopin-ai
```

Requires Node.js 24.8 or later.

## Quick start

```bash
cd my-project
chopin
```

The first run connects a provider, by its sign-in or an API key, and picks a model. `/hotkeys` lists the keys.

## Features

- **Durable conversations.** Every step is saved before it is shown, so a run cut off by a restart picks up where
  it stopped.
- **One agent, every client.** Each project has a background service; the terminal and editors (`chopin acp`)
  join the same conversation, and closing the terminal leaves the agent working.
- **Any provider.** `/login` connects one by its sign-in or an API key; `/model` and `ctrl+p` switch models
  mid-conversation.
- **Your shell in the conversation.** `!command` runs a command the agent then sees; `!!command` keeps it to you.
- **Steer while it works.** `enter` steers the running turn, `alt+enter` queues a follow-up, `alt+up` takes
  queued messages back.
- **Conversations that branch.** `/resume`, `/fork`, `/compact` and `/export`.
- **Your project's instructions.** `AGENTS.md` files from the repository root down to the working directory are
  read before every request.
- **Workspaces per user.** `chopin serve` runs one container workspace per user, who is named by the integrator's
  signed tokens.

## How it improves itself

The agent's behavior lives in a mutable layer: `AGENTS.md` instructions, Agent Skills, MCP servers and gate rules,
shared by both harnesses, plus each harness's own code. The layer uses open formats, so what it learns carries over
to other agents. Write your own in `~/.chopin/layer`, and check one with `chopin layer check <dir>`.

The RSI (recursive self-improvement) loop runs in the background on your local sessions, chopin's and other agents'.
When one kind of failure recurs in two sessions and still happens often when those sessions are resumed, it reads every
time it happened, with your corrections, and proposes a single instruction or skill. It keeps the change only when,
resumed at the steps that failed and at steps that went right in other conversations, it mends at least two of the
failures and fixes more than it breaks, so that false gains stay a bounded share of the changes kept. Each change can
be undone, one unused for 30 days is archived, and spending stops at a weekly budget.

- `chopin evolve` runs a round now; `evolve status`, `evolve log` and `evolve undo <id>` show and revert changes.
- `chopin evolve corrections` asks, kind by kind, whether the agent should learn from how your messages corrected it.
- `chopin evolve review` approves or refuses the changes the audit could not settle, held for you when
  `holdForReview` is on; an approved one is still tested before it is kept.
- `rsi` in `~/.chopin/config.json` turns it on: `regularModel`, `strongModel`, `weeklyBudgetUsd`,
  `transcriptSources` for other agents' session logs, `rulesFile` for rules no change may break, and `holdForReview`.

On macOS, commands the agent runs can neither read nor write `~/.chopin`, which holds credentials, conversations
and the loop's records. Other systems do not enforce this, and neither does a container engine the agent's commands
can reach, since a container can mount any directory.

## Configuration

| Where | What |
|---|---|
| `~/.chopin/auth.json` | Credentials saved by `/login`; a provider's usual environment variable works too |
| `~/.chopin/config.json` | Default model, `enabledModels` for `ctrl+p`, theme, `httpProxy`, `rsi` |
| `~/.chopin/models.json` | Extra providers and models |
| `~/.chopin/layer/` | `AGENTS.md`, `skills/<name>/SKILL.md`, `mcp.json`, `gates.yaml` |
| `CHOPIN_MODEL` | Overrides the default model |
| `CHOPIN_HOME` | Moves `~/.chopin` |
| `HTTP_PROXY`, `HTTPS_PROXY` | Route requests through a proxy |

## For integrators

`chopin serve --jwks <url>` runs agents for many users, each in a container workspace; build the image from a
checkout with `pnpm --filter @chopin-ai/harness-pi image`. Clients reach it through the client protocol or ACP.

| Package | Purpose |
|---|---|
| `chopin-ai` | The `chopin` command: terminal client, ACP and the project service |
| `@chopin-ai/core` | Mutable-layer formats, ACP transcripts, the RSI loop's core and `chopin layer check` |
| `@chopin-ai/workspace` | Workspace lifecycle interface with directory and container implementations |
| `@chopin-ai/harness-pi` | Durable harness adapter: agent service, client protocol, ACP bridge |
| `@chopin-ai/harness-dsh` | Plugin harness adapter: mutable-layer loading, headless runs |

## Development

Requires pnpm 12.

```bash
pnpm install
pnpm typecheck   # packages and tests
pnpm test
```

[`v0.1.0`](https://github.com/CodePrometheus/chopin-ai/releases/tag/v0.1.0) archives the previous design.
[CHANGELOG](CHANGELOG.md) lists every release.

## License

[Apache-2.0](LICENSE)
