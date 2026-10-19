# chopin-ai

A coding agent built to improve itself. Its RSI (recursive self-improvement) loop is meant to change a mutable
layer of skills, instructions, tools and harness code, and to accept a change only when a sealed evaluator, which
the agent cannot touch, shows that it helps.

> **Status:** `v0.2.0` ships the agent, both harness adapters, the workspace layer and the mutable-layer formats.
> The RSI loop itself is not built yet. [`v0.1.0`](https://github.com/CodePrometheus/chopin-ai/releases/tag/v0.1.0)
> archives the previous design.

## Design

- **Harness-agnostic core.** Two harnesses are first-class targets. Each adapter only loads the mutable layer,
  runs tasks headless and converts transcripts to ACP events.
- **Open formats.** Skills follow Agent Skills, instructions follow AGENTS.md, tools are MCP servers and
  transcripts are ACP events, so an improvement can be measured on other agents too.
- **A workspace per user.** A lifecycle interface for isolated, persistent workspaces; a local container
  implementation ships, and cloud implementations plug in.
- **Built for integrators.** Identity comes from the integrator's signed tokens, credentials are injected per
  person, and agents are reachable through a client protocol or ACP.

## Usage

```bash
cd my-project
chopin        # talk to an agent working in this directory
chopin web    # the same conversation in the browser
chopin acp    # for editors and other ACP clients
chopin login  # connect a provider by its sign-in or an API key
```

The first run connects a provider and picks a model. In a conversation, `/login` and `/logout` manage providers and
`/model` switches the model; a provider's usual environment variable works too.

`chopin serve` runs agents in containers instead, for shared or remote use; build its workspace image first with
`pnpm --filter @chopin-ai/harness-pi image`.

## Packages

| Package | Purpose |
|---|---|
| `@chopin-ai/core` | Mutable-layer formats, ACP transcripts and the `chopin layer check` command |
| `@chopin-ai/workspace` | Workspace lifecycle interface with directory and container implementations |
| `@chopin-ai/harness-pi` | Durable harness adapter: agent service, client protocol, ACP bridge |
| `@chopin-ai/harness-dsh` | Plugin harness adapter: mutable-layer loading, headless runs |
| `chopin-ai` | The `chopin` command: terminal client, web app, ACP and the project service |

## Development

Requires Node 24.8 or later and pnpm 12.

```bash
pnpm install
pnpm typecheck   # packages and tests
pnpm test
```

## License

Apache-2.0
