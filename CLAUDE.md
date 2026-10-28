# chopin-ai

A self-improving coding agent. Its RSI (recursive self-improvement) core is harness-agnostic: it improves the
agent by changing a mutable layer, and a change is accepted only when a sealed evaluator says so. Two harnesses
are first-class targets, each behind its own adapter.

The design record is `.agents/plan-oss-agent.md` and task progress lives in `.agents/todo.md` (both local, not
in git). `v0.1.0` archives the previous design; nothing from it is carried over.

## Architecture

pnpm monorepo, split by boundary rather than by feature:

- `packages/core` — harness-agnostic: mutable-layer formats, ACP events with `_meta` extensions, evaluation and
  acceptance, the `chopin` commands. It imports no harness.
- `packages/workspace` — the per-user workspace lifecycle (provision, pause and resume, idle reclaim, persistent
  volume, isolation, connection) and its local container implementation. Cloud implementations belong to
  integrators.
- `packages/harness-pi` — the durable harness: an agent service that keeps one store per user outside the
  workspace and runs tools inside it through the execution daemon, the client protocol with its client library,
  and the ACP bridge.
- `packages/harness-dsh` — the plugin harness: one plugin that loads the mutable layer, and headless task runs.
- `apps/tui` — the `chopin` command, published as `chopin-ai`. Local use takes no options: the current directory is
  the workspace, each project's service runs in the background, owned by no terminal, which every `chopin` and editor
  joins, and providers and models are picked in the terminal. `chopin serve` runs container workspaces for
  shared use. The loop runs from here too: services export their transcripts, and `chopin evolve` reads only those.

Every adapter does exactly three things: load the mutable layer, run one task headless and return its transcript
and workspace diff, and convert transcripts to ACP events. The durable harness also continues a transcript at one step
without running tools, which the daily loop's gate needs. Anything else a harness offers stays in its adapter.

## Hard constraints

- The mutable layer has two tiers. Portable: skills (`<name>/SKILL.md`), AGENTS.md instructions, MCP servers and
  gate rules, shared by both harnesses. Native: a harness's own code, delivered as a pull request and evaluated on
  that harness alone.
- The loop has two modes. Daily mode, the default, needs no container: it changes one instruction or skill at a
  time, and a sealed gate accepts it only on a net gain over continued decision points, at the level the
  false-acceptance ledger allows. Experiment mode, for benchmarks and native changes, runs the same tasks and
  verifiers on both harnesses, each against its own baseline and noise band, in sandboxes obtained only through the
  workspace interface; a portable change is accepted there only if neither harness regresses and one improves.
- What the agent must not change stays out of its reach: credentials, conversation storage, the evaluator and its
  tasks, memory. Local mode hides the chopin home from the agent's commands on macOS; other systems, a container
  engine those commands can reach, and the plugin harness, which shares a container with its agent, are known
  exceptions, not precedents.
- A store belongs to one process at a time; scale out by assigning users to processes.
- Identity comes from short-lived tokens signed by the integrator and verified with its public key. Local
  single-user mode moves a launch token from the address into an `HttpOnly` cookie, and a WebSocket from another
  origin is refused. There are no accounts.
- Both harnesses reach models through the same model library. Credentials are per person, injected by the
  integrator, and never stored in the repository.
- Prefer open standards to formats of our own: ACP for events and integration, Agent Skills, AGENTS.md, MCP.
- No product names, internal information, secrets or absolute paths in code; configuration comes from the
  environment.
- A dependency is added when code first uses it, not ahead of time.

## Conventions

- English everywhere: comments, identifiers, logs, errors, docs and commit messages.
- File and directory names are kebab-case.
- Named exports only, except a default export a tool requires, such as its config file; an import of types alone
  uses `import type`, and one that mixes values and types marks its types inline.
- Async I/O only (`fs/promises`).
- Cross-package imports go through package exports.
- Comments state intent and constraints; history belongs in commit messages.
- Tests live in `<package>/tests/*.spec.ts`, or `*.spec.tsx` for those that render components.
