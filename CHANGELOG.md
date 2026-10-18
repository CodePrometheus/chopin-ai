# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/CodePrometheus/chopin-rsi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CodePrometheus/chopin-rsi/releases/tag/v0.1.0
