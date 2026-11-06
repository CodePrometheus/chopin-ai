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

> **Status:** `v0.5.0` signs a cloud agent's owner in to any model provider from their clients, and `v0.4.0` keeps
> what they have sealed at rest; the loop that improves the agent from your sessions came in `v0.3.0`, see
> [How it improves itself](#how-it-improves-itself).

## Install

```bash
npm install -g chopin-ai
```

Requires Node.js 24.8 or later.

## Quick start

Start chopin in the project you want it to work on:

```bash
cd my-project
chopin
```

1. **Connect a provider.** The first run asks for one, by its sign-in or an API key, then for a model, which becomes
   the default. A key already set in the provider's usual environment variable skips the first step. `/login`
   connects another provider later, and `/model` switches models.
2. **Give it a task.** Type what you want and press `enter`. While it works, `enter` steers the running turn and
   `alt+enter` queues a follow-up.
3. **Come back any time.** The agent runs in the project's background service, so closing the terminal does not stop
   it. Run `chopin` in the same directory again, and `/resume` picks up the conversation, finished or still running.
4. **Work from your editor.** Have an ACP client run `chopin acp` in the project; it joins the same service as the
   terminal.

`/hotkeys` lists every key.

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
| `CHOPIN_TOKEN` | The one credential `chopin serve --workspace-port` admits |
| `HTTP_PROXY`, `HTTPS_PROXY` | Route requests through a proxy |

## For integrators

`chopin serve --jwks <url>` runs agents for many users, each in a container workspace; build the image from a
checkout with `pnpm --filter @chopin-ai/harness-pi image`. Clients reach it through the client protocol or ACP.

`chopin serve --workspace-port <port> --root <dir>` serves one user whose workspace runs beside it on the same
network, such as another container of the same pod, running the workspace package's
`loopback-listener.sh <port> <daemon>`. It admits the credential in `CHOPIN_TOKEN`, starts conversations with the
model `CHOPIN_MODEL` names, and `GET /status` with that credential says whether it is busy. The user's client hands
it their model API key, or signs them in to a provider, through the client protocol, and it keeps what it gets in
memory alone.

With `--sealed <dir>` (Node 24.16 or later) it keeps that user's conversations, settings, loop records, and the
credentials and MCP servers clients hand over only sealed on `<dir>`, and starts locked, reading nothing until a client
unlocks it. Conversations are then held in memory, each commit journaled to `<dir>` before it takes effect, and
`CHOPIN_HOME`, which must be memory-backed, is restored from `<dir>` and synced back to it, credentials, settings and
MCP servers as they are written; the workspace's files stay as they are. Sealing keeps what the volume holds from being
read, not from being put back: a volume replaced by an earlier copy of itself, or its journal cut at a record's end,
opens as that earlier state. Clients make the user's data key and wrap it by a passphrase and a recovery key with
`@chopin-ai/harness-pi/keys`, unlock with `unlock` from the client protocol, and derive a key for a purpose of their
own with `integratorKey`.

| Package | Purpose |
|---|---|
| `chopin-ai` | The `chopin` command: terminal client, ACP and the project service |
| `@chopin-ai/core` | Mutable-layer formats, ACP transcripts, the RSI loop's core and `chopin layer check` |
| `@chopin-ai/workspace` | Workspace lifecycle interface with directory, container and socket implementations |
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
