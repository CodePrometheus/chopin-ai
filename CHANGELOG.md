# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A conversation left idle is compacted just before its prompt cache expires, with a summary request that reads that
  cache, so coming back costs a short context instead of a full rewrite.
- The RSI loop: `chopin evolve` turns failures that recur across local sessions into one instruction or skill at a
  time, kept only when resumed conversations show a net gain, within a weekly budget.
- On macOS, commands the agent runs can neither read nor write `~/.chopin`.

### Removed

- The web app and `chopin web`; the terminal and editors are the clients.

## [0.2.0] - 2026-10-21

A ground-up rewrite under the new name `chopin-ai`. The RSI loop is not part of this release, and nothing from 0.1.0
is carried over.

### Added

#### Terminal

- `chopin` talks to an agent in the current directory; each project has one background service that every terminal,
  browser and editor joins.
- `chopin web` opens it in the browser, `chopin acp` serves it to ACP clients, `chopin acp <url>` reaches a remote one.
- Local mode runs the agent as you, in your directory; `chopin serve` runs it in containers.
- `chopin login`, `/login` and `/logout` connect providers by sign-in or API key, kept in `~/.chopin/auth.json`.
- `/model` and `ctrl+l` pick a model, `ctrl+p` cycles through `enabledModels`, `/thinking` and `shift+tab` set thinking.
- `/new`, `/resume`, `/fork`, `/name`, `/compact`, `/copy`, `/export`, `/session`, `/settings`, `/mode` and `/hotkeys`.
- `!command` runs a command the agent then sees; `!!command` keeps it out of the context.
- `alt+enter` queues a message, `alt+up` takes queued ones back, `ctrl+v` pastes files, images or text.
- The footer shows tokens, cost and context use.
- `HTTP_PROXY`, `HTTPS_PROXY` or `httpProxy` in `~/.chopin/config.json` set the proxy.
- `~/.chopin/models.json` adds providers, `CHOPIN_MODEL` overrides the default model, `CHOPIN_HOME` moves `~/.chopin`.

#### Workspaces

- A workspace lifecycle interface with directory and container implementations.
- Idle reclaim stops idle owners' workspaces and keeps their volumes.
- Snapshots of a workspace and binary patches of what a run changed.

#### Mutable layer

- A portable layer shared by both harnesses: `AGENTS.md`, Agent Skills, MCP servers and gate rules, loaded from
  `~/.chopin/layer`.
- `chopin layer check <dir>` reports every problem in a layer.
- Gates refuse a call until the tools it requires have succeeded in the session.

#### Transcripts

- Transcripts are ACP session updates in JSON Lines, with chopin's own facts under `_meta.chopin-ai`.
- A task run returns its transcript and the patch it made to the workspace.

#### Durable harness adapter

- An agent service with one store per owner, kept out of the workspace; tools reach it through an execution daemon.
- The agent reads the project's `AGENTS.md` or `CLAUDE.md`, one per directory up to the root, anew each turn.
- `read` and `full` modes per conversation.
- A WebSocket client protocol; owners come from a launch token or integrator-signed tokens (`chopin serve --jwks`).
- An ACP bridge for any agent of the service.
- A workspace image with source tools and the execution daemon.

#### Plugin harness adapter

- A plugin that loads the layer into the plugin harness and records ACP transcripts.
- Headless task runs in the workspace, and a workspace image with the harness and the plugin.

#### Web app

- A browser UI on the client protocol: conversations, transcript, composer, mode switching and stop.

### Changed

- The project is renamed `chopin-ai` and published under `@chopin-ai/`; the command stays `chopin`.

### Removed

- Everything in 0.1.0, kept by the `v0.1.0` tag: missions, the conclusion ledger, signals, toolsets, the evolution
  pipeline, ultra and team modes.
- The `chopin install`, `service`, `experience` and `--session` commands, and every `CHOPIN_*` setting of 0.1.0.

## [0.1.0] - 2026-10-18

Initial release. Chopin is an RSI (recursive self-improvement) executor: it drives a long-running
engineering project and improves itself along the way, under gates that trust only the tool-call log.
It is composed as plugins, a bundle and preset patches on top of a base agent harness, which provides
the agent loop, sessions, UI, skills and model access.

### Added

#### Missions and gates

- Missions declared as configuration: each kind of work is one preset row with an output schema and the
  gates that must hold before submission, so adding a mission needs no code.
- The bundled `chopin` preset with four submission tools: `submit_root_cause_report`, `submit_delivery`,
  `submit_evolution` and `submit_curation`, each carrying its own gates.
- Gates enforced by a monotonic tool guard and satisfied only by tool calls that completed successfully in
  the session log; a model's claim that it already did the work does not count.
- `pnpm check:composition`, which fails when a gate names a tool that nothing registers, instead of letting
  the mission deadlock at runtime.

#### Ledger and experience

- A conclusion ledger shared across missions and sessions: error strings are normalized, lookup
  (`ledger_search`) is exact-match only, and every write (`ledger_write`) requires your approval.
- Three experience layers: automatically captured conversational facts, a pending area for candidates
  (`curation_pending_record`, `curation_pending_list`, `curation_pending_merge`, `curation_pending_settle`,
  `curation_review`), and the approved ledger. Only the last layer is admission-controlled.
- Deterministic session-log signals (`session_signals`): credential scrubbing, normalized merging and
  cross-session counting. The model never reads raw session logs.

#### Project onboarding

- Declarative YAML toolsets: config constants (`${VAR}`), model parameters (`{{param}}`, single-quoted and
  refused when they start with `-` unless allowed), prerequisites and per-tool output budgets. A toolset
  whose prerequisites fail is not registered and is named in the log.
- Signal source adapters for issues, logs and error monitoring, with deterministic triage (`triage_run`)
  configured through `CHOPIN_SOURCES_FILE`. An unavailable source is reported as skipped or failed with a
  reason, never dropped silently.
- Evidence bundle retrieval (`bundle_fetch`) and agent trace tools (`trace_list_runs`, `trace_get_run`,
  `trace_reconstruct_history`, `trace_system_prompt`).
- Project settings through environment variables: `CHOPIN_REPO_PATH`, `CHOPIN_TEST_COMMAND`,
  `CHOPIN_BUILD_COMMAND`, `CHOPIN_LINT_COMMAND`, `CHOPIN_LEDGER_DIR`, `CHOPIN_GITHUB_REPO`,
  `CHOPIN_USER_INSTRUCTIONS` and `CHOPIN_CLAUDE_SKILLS_DIR`.

#### Self-evolution

- An authoritative append-only evolution log: every append replays and validates the full history under a
  cross-process lock.
- Candidate and artifact-version state machines advanced only by the host (verify, deploy, retire,
  resolve). The model cannot submit feedback aggregates, approval receipts or rollback targets.
- Failure evidence captured from committed session events, with session outcomes folded into a cumulative
  feedback window.
- An experience index with trigger conditions and structured filters (`experience_read`), and user
  corrections recorded as evidence through approval (`evolution_correction_record`).
- `submit_evolution` gated on a runtime contract query, a full mount of the composition in a throwaway
  profile (`chopin_smoke`), the test suite and a diff review.
- Executable capabilities bound to an exact fixture and your approval, canaried in a fresh OS sandbox and
  hot-activated at model step boundaries. A deployed capability that fails more often than it passes is
  quarantined, and gate changes never activate automatically.
- Budgeted improvement experiments through `/rsi`: `run <limit>` authorizes one experiment, with `stop`,
  `resume`, `tasks` and the `audit`, `recheck`, `probe` and `assess` modes. Search candidates stay in an
  archive; promotion requires sealed holdout tasks to pass in an isolated child process. Real failures are
  saved as replay tasks without calling the model.
- `chopin experience` to inspect deployed experience artifacts.

#### Modes

- Ultra mode (`/mode ultra`, `/mode standard`): maximum reasoning plus two to three bounded parallel
  workers; standard effort is restored from the session log.
- Experimental team mode: a lead session interviews you, submits a batch of structured tasks whose
  acceptance checks exist before you approve it, and a deterministic engine runs each task in its own
  worktree slot as bounded one-shot worker rounds, delivering a commit on the task branch after re-running
  the completion gates. Configured in `.chopin/team.yaml`. It is not carried into the next release.

#### Unattended operation and CLI

- `chopin` opens the terminal UI, `chopin web` the browser UI, and `chopin --session <id>` resumes a
  session with the proxy and preloads applied.
- `chopin install` prepares both profiles, links the plugin packages and writes the model catalog.
- `chopin service` writes a macOS service definition for unattended runs and leaves loading it to you.
  Auto-continue after transient failures, long-running goals and scheduled tools are enabled; evolution
  runs only while you are present.
- End-of-turn notifications and one automatic retry of transient tool failures.
- Model endpoint proxy through `CHOPIN_LLM_PROXY`, and opt-in hot reload while developing with
  `CHOPIN_HMR=1`.

[unreleased]: https://github.com/CodePrometheus/chopin-ai/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CodePrometheus/chopin-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodePrometheus/chopin-ai/releases/tag/v0.1.0
