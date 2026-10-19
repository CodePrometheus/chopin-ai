# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-19

A ground-up rewrite under a new name, `chopin-ai`. The agent, both harness adapters, the workspace layer and the
mutable-layer formats are in place; the RSI loop that will change that layer under a sealed evaluator is not part of
this release. Nothing from 0.1.0 is carried over.

### Added

#### Local use

- A bare `chopin` talks to an agent working in the current directory. Each project has one service, started in the
  background when none runs and owned by no terminal: every terminal, browser and editor of the project joins it,
  closing any of them ends none of the others, and the service ends on its own once no client has been connected for
  five minutes and its agent has nothing left to do. An OS lock, released however its holder ends, keeps it to one
  service per project even when several start at once, and a service that crashed is replaced on the next `chopin`;
  a terminal or editor still attached follows it there.
- In the terminal, `/new` starts a conversation, `/model` moves it to another model, which new conversations then
  start with too, and `/mode read|full` sets what it may do; any other line that starts with `/` is refused rather
  than sent to the model, and `//` sends one that does.
- `chopin web` opens the same project in the browser, and `chopin acp` lets an ACP client, such as an editor, drive
  it over stdio; `chopin acp <url>` drives an agent of a remote service instead, with the credential from
  `CHOPIN_TOKEN` sent as a bearer header, never in the address.
- Local mode runs the agent as you, in your directory: its tools reach whatever you can, chopin's own files
  included. `chopin serve` runs it in containers instead.
- Providers are connected in the terminal, by their sign-in or an API key: the first run asks for one when none is
  connected, then for a model; `/login` and `/logout` in a conversation and `chopin login` outside one connect and
  disconnect them later. Each list narrows as you type and marks what is already set up. Credentials are kept in
  `~/.chopin/auth.json`, readable only by you and shared by every chopin of the machine, so a sign-in reaches a
  running service at once; a provider's usual environment variable works too. Every request goes through the proxy
  that `HTTP_PROXY` and `HTTPS_PROXY` name, or `httpProxy` in `~/.chopin/config.json`, sparing `NO_PROXY`'s hosts
  and this machine's own addresses.
- The default model is kept in `~/.chopin/config.json`, read anew for each conversation; `CHOPIN_MODEL` overrides
  it. Every chopin service, local or served, loads the mutable layer in `~/.chopin/layer` when present.
  `CHOPIN_HOME` moves `~/.chopin`, project stores included.

#### Workspaces

- A workspace lifecycle interface: provision, pause and resume, stop, destroy, and a command line that runs a
  program inside the workspace with stdio attached.
- A directory implementation for local use, which never deletes the user's directory, and a container implementation
  with one container and one named volume per owner, isolated by provider prefix.
- Idle reclaim stops the workspaces of owners idle past a threshold, a few at a time, and keeps their volumes; an
  owner whose agent is still working, or who got to work while the sweep ran, is never idle, and one a restarted
  service has not seen yet is given the whole threshold first. `chopin serve --prefix` keeps services that share an
  engine apart, each with its own workspaces and store. An agent no client holds that has been idle as long is
  closed too, so a service that has seen many owners keeps open only those in use.
- Helpers to run a program in a workspace, to snapshot its version-controlled work tree and to take what changed
  under the workspace root since a snapshot as a binary patch, untracked files included, through a throwaway index.
  The patch is the change as a commit in that repository would record it, each file's bytes kept whatever its
  encoding; the user's diff display settings never shape it, and what cannot be staged, such as an unreadable file,
  is left out rather than failing the run.

#### Mutable layer

- A portable layer of open formats shared by both harnesses: `AGENTS.md` instructions, Agent Skills
  (`<name>/SKILL.md`), MCP servers over stdio or Streamable HTTP (`mcp.json`) and gate rules (`gates.yaml`). MCP
  server names are 1 to 32 letters, digits, `_` or `-`, without `__` or a trailing `_`, so every harness accepts
  them and every tool name points to one server. A command server's `env` names are portable variable names, other
  than `_` and those starting with `CHOPIN_ENV_`. `chopin layer check <dir>` reports every problem at once.
- A skill reads the same on both harnesses: its `SKILL.md` without the frontmatter.
- Gate semantics shared by both harnesses: a call is refused until every required tool has succeeded earlier in the
  session. A gate naming a tool nothing provides is a configuration error: the durable harness refuses to start with
  one on a built-in tool and names one on an MCP tool when it starts, and the plugin harness, whose MCP tools arrive
  after it loads, names it when a gated call is refused. Both harnesses name MCP tools `mcp__<server>__<tool>` the
  same way, so one gate file holds for either.

#### Transcripts

- Transcripts are ACP session updates in JSON Lines, ending each turn with its stop reason and usage, counted the
  same way on both harnesses, input including what the cache served. Facts ACP does not carry live under the
  namespaced `_meta` key `chopin-ai`: the model, the failure with the provider's own message, and the cost where the
  harness reports one, which the plugin harness does not.
- A task run returns its transcript together with the patch the workspace took while it ran; work already
  uncommitted before it started is left out. The workspace is the owner's, so a run that must stand alone, such as
  one being evaluated, has an owner of its own.

#### Durable harness adapter

- An agent service with one durable store per owner, kept outside the workspace and readable by its user alone;
  tools reach the workspace only through an execution daemon, which starts the workspace on first use and again
  after it was reclaimed. In a container workspace, the store and the layer are out of the agent's reach.
- Skills are served from outside the workspace, so in a container workspace the agent can read but never edit them;
  MCP command servers run inside the owner's workspace; gates are enforced before every tool call. An MCP server
  that does not answer is reported and left out rather than failing the agent, and tried again until it does;
  meanwhile a call gated on its tools is refused with the reason.
- `read` and `full` modes per conversation; a read-only conversation admits only tools that change nothing, MCP
  tools by the read-only annotation their server gives them.
- A client protocol over WebSocket: each object belongs to the owner that asked for it, state arrives as a snapshot
  followed by deltas. A dropped link is dialled again, and the reconnect yields the current state, how the latest
  messages ended included; a call that waits longer than 30 seconds for the service fails, and a message sent again
  under the same request is admitted once, so resending after a failure never doubles it. Owners come from a launch
  token in local mode or from short-lived tokens the integrator signs (`chopin serve --jwks`). `chopin serve` runs
  every owner's agent with the host's own provider credentials; an integrator that injects each person's credentials
  builds the service with its own `models(owner)`; a browser's credential moves into an `HttpOnly` cookie named per
  port, so services on one machine never overwrite each other's, and a WebSocket opened by a page of another origin
  is refused.
- An ACP bridge speaks ACP for any agent of the service; a request to a service that stays away fails after 30
  seconds rather than waiting for good, and a prompt whose link fails mid-send is sent again, admitted once. A
  prompt's resource links reach the model as their names and addresses. The agent works in its own workspace with
  the MCP servers of its layer, so the working directory and MCP servers a client names for a session are not used.
- A workspace image with source tools and the execution daemon.

#### Plugin harness adapter

- A plugin that loads the layer into the plugin harness: instructions, skills, MCP servers and gates, which read
  successful calls from the session log through a projection that resume and fork replay.
- ACP transcripts recorded from the session log, flushed before the process exits: messages, reasoning, tool calls
  and their results as text, leaving out attachments; a turn the harness interrupted or rejected is marked failed.
- Headless task runs inside the workspace, the prompt passed on standard input; a run the harness did not finish
  keeps what it recorded and is marked failed. A workspace image with the harness and this plugin.

#### Web app

- A browser UI on the client protocol: conversations, the transcript with tool results folded into their calls, a
  composer, mode switching and stopping a running turn. Agent markdown renders as elements, never as raw HTML. Like
  the terminal, it says why a message got no answer, and a message that could not be sent comes back.

### Changed

- The project is renamed `chopin-ai`, its packages are published under `@chopin-ai/`, and the command package is
  `chopin-ai`; the command stays `chopin`.

### Removed

- Everything in 0.1.0, which the `v0.1.0` tag keeps: missions as presets with their submission tools, the conclusion
  ledger and the pending area, session signals, declarative YAML toolsets, signal sources and triage, evidence and
  trace tools, the self-evolution pipeline, executable capabilities, ultra mode and team mode.
- The `chopin install`, `chopin service`, `chopin experience` and `chopin --session` commands, end-of-turn
  notifications and the automatic retry of transient tool failures.
- Every `CHOPIN_*` setting of 0.1.0, among them `CHOPIN_LLM_PROXY`, `CHOPIN_HMR`, `CHOPIN_SOURCES_FILE` and the
  project settings such as `CHOPIN_REPO_PATH`, and the Chinese README.

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
