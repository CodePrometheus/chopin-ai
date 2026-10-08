# chopin-rsi

[中文](README.zh-CN.md)

Chopin is an RSI (recursive self-improvement) executor built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).
It drives a long-running engineering project and improves itself along the way, under gates that trust
only the tool-call log.

dsh provides the agent loop, sessions, UI, skills and model access. Chopin adds:

- **Gates**: a submission is refused until the session log shows the required tool calls succeeded.
- **Ledger**: conclusions persist across sessions, are searched by exact match, and are written only with your approval.
- **Evolution**: chopin changes itself only through repository files that pass its own checks.
- **Config, not code**: onboarding a project is YAML.

A refused submission:

```
Rejected by 1 unmet investigation gate(s):
- recurrence-ledger: Search the defect ledger first. Recurring N times means the previous
  N-1 fixes were at the wrong layer, which changes what counts as a root cause here.
Satisfy them with real tool calls. Only the tool-call log counts; stating that you already
did this does not.
```

## Install

Requires Node 22.19+ or 24 and pnpm 12. Executable code chopin generates for itself runs only on macOS.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm exec chopin install   # prepare the dsh profiles
pnpm exec chopin           # terminal UI; `chopin web` for the browser
```

Put `ANTHROPIC_API_KEY` in `~/.dsh/.env`, or use `/login` in the UI; any credential is subject to its
provider's terms. Always start through `chopin`, including `chopin --session <id>` to resume: it applies
the proxy and preloads. `/mode ultra` adds parallel workers to the current session.

Install turns off the bundled memory plugin's usage telemetry. Feedback you submit in the UI uploads that
session to dsh's collector; set `DSH_TELEMETRY_DISABLED=1` to turn that off too.

### Configuration

Optional, in `~/.dsh/.env`:

| Variable | Meaning |
|---|---|
| `CHOPIN_REPO_PATH` | project to work on (default: current directory) |
| `CHOPIN_TEST_COMMAND`, `CHOPIN_BUILD_COMMAND`, `CHOPIN_LINT_COMMAND` | the project's checks (default: pnpm scripts) |
| `CHOPIN_LEDGER_DIR` | approved conclusions (default `~/.chopin/ledger`) |
| `CHOPIN_GITHUB_REPO` | `owner/repo` for issue history |
| `CHOPIN_SOURCES_FILE` | signal sources to poll (template `examples/sources.example.yaml`) |
| `CHOPIN_LLM_PROXY` | proxy for the model endpoint |
| `CHOPIN_USER_INSTRUCTIONS` | your rule files as a JSON array (default `~/.claude/CLAUDE.md` if present) |
| `CHOPIN_CLAUDE_SKILLS_DIR` | extra skill directory (default `~/.claude/skills`) |
| `CHOPIN_HMR=1` | hot reload while developing chopin |

## Onboarding a project

Project constants are the variables above. Signal sources (issues, logs, error monitoring) go in the file
named by `CHOPIN_SOURCES_FILE`. Commands are YAML toolsets in `toolsets/`, enabled by name in the
preset's `chopin-toolset` row. Hand-written playbooks go in `~/.agents/skills/` and are used verbatim.

```yaml
- name: repo_show_at_tag
  description: Show a file as it was at a release tag.
  command: git -C ${REPO_PATH} show {{tag}}:{{path}}
  params:
    tag: { description: the release tag }
    path: { description: repo-relative file path }
  outputBudgetBytes: 32768
```

`${VAR}` is a config constant. `{{param}}` is model input, single-quoted, and refused if it starts with
`-` unless marked `allowLeadingDash: true`. A toolset whose prerequisites fail is not registered and is
named in the log.

## Adding a mission

A mission is one `@chopin/report` row in the preset: its output schema and its gates.

```yaml
- id: chopin-report-root-cause
  name: '@chopin/report'
  config:
    tool:
      name: submit_root_cause_report
      description: File the finished analysis.
      parameters: { type: object, required: [problem, rootCause], properties: { ... } }
    gates:
      - id: recurrence-ledger
        description: Search the defect ledger first.
        satisfiedByTools: [ledger_search]
```

Then run `pnpm check:composition`: it fails if a gate names a tool nothing provides.

## How chopin evolves

Experience climbs from MemOS facts to pending candidates to the ledger you approved; a recurring lesson
becomes a toolset or a gate rule. `submit_evolution` requires a runtime contract query, a full mount in a
throwaway profile, chopin's tests and a diff review. Generated executable code runs sandboxed, needs your
approval and is canaried before it goes live. Gate changes never activate automatically, and a deployed
capability that fails more often than it passes is quarantined.

## Unattended operation

`chopin service` writes a launchd plist (loading it is your call), turns auto-continue after transient
failures, `ralph` runs long tasks and `schedule_*` tools run on a clock. Evolution happens only while you
are present.

## Development

```bash
pnpm typecheck            # packages and tests
pnpm test                 # unit tests
pnpm test:e2e             # real dsh compositions
pnpm check:composition    # every row resolves, every gate names a real tool
pnpm smoke:composition    # mount the whole composition in a throwaway profile
```

Architecture and conventions are in `CLAUDE.md`.

## License

Apache-2.0. The bundled `grilling` and `grill-me` skills keep their MIT license.
