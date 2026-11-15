# Durable goals

`AgentServiceOptions.goals(owner)` enables an execution-owned goal driver for each
owner. Goals, conversations, tasks, command receipts, and completion evidence use
the same durable store. A host stores delivery and authorization metadata, without
copying the execution state machine.

This is an embedded service interface. The command-line service does not install
cloud authority, effect reconciliation, or a review model automatically.
User extensions are not isolated by this interface: hosts must supply separate
execution and permission boundaries before admitting third-party code.

## Commands and observation

The version 2 `chopin.goals` contract accepts version 1 `EngineCommand` envelopes:

- `goal.submit` supplies an objective, completion criteria, and a concrete grant
  revision. Its request ID becomes the goal ID. An explicit continuation may fork
  the committed context of a terminal goal at its expected version.
- `goal.input` supplies additional input at an expected goal version. A pending
  question requires its original question ID. Replacing authority requires an
  explicit grant; ordinary input preserves the adopted grant.
- `goal.stop` records stop intent at an expected version before interrupting work.
  A receipt acknowledges this intent; the goal becomes stopped only after owned
  work and original external operations have drained.

The receipt, driver task, work conversation, and goal are admitted in one
transaction. A duplicate request with identical content returns its original
receipt, even after the goal advances. Reusing the ID for different content is
rejected. After an uncertain response, query `request` with the original request
ID; a failed lookup does not establish absence.

Use `chopin.goal` for authoritative snapshots and changes. Its revision is an
execution revision, separate from transport acknowledgements and observer update
counts. Page cursors bind to the owner; history cursors also bind to the original
conversation and history boundary. History and goal cursors are not interchangeable.

## Trusted adapters

`GoalOptions` requires these host implementations:

- `authorize` checks the current owner or concrete delegated grant before admission,
  model requests, retries, compaction, and named tool execution. The resource gateway
  must additionally authorize the actual resource arguments. Unknown authority
  blocks execution; it never grants permission.
- `review` selects an explicit model with `{ model: { provider, modelId } }` for
  the built-in durable reviewer, or supplies a trusted custom callback. A callback
  receives a stable review ID and returns completion, further instructions, or a
  question or scheduled wait. It must be read-only or reconcile its own work under
  that identity. A failed observation retries the same review without sending a
  fresh task prompt. Empty initial criteria must be established before completion;
  established criteria cannot be silently replaced.
- `settled` resolves only after original external operations and output are
  reconciled. It must reject or wait on unknown state, including during stop.
- `artifact`, when artifact evidence is used, verifies the actual bytes and digest
  under this goal's resource authority. It cannot rely on an asserted path alone.
- `retryAfterMs` is the host's explicit recovery policy. `report` records failures
  without exposing private inputs or credentials.

The driver checks that evidence belongs to this goal and covers every criterion.
Tool evidence must identify the exact committed result of a completed tool task.
Assistant evidence must contain an actual final answer. These provenance checks do
not establish semantic correctness; the trusted reviewer owns that assessment.
The driver also records and checks required post-run task outcomes before accepting
a review. A failed post-run task remains an explicit dependency wait.

Direct conversation execution is disabled when goals are enabled, unless the host
explicitly opts into legacy conversations. A goal-controlled conversation still
rejects direct submission, shell execution, reset, and similar bypasses. Required
goal guards remain installed when optional extensions are deselected. Driver
instructions are marked separately from owner input and are not owner corrections.

## Recovery and limits

The built-in reviewer runs as an owned native task with a private conversation. It
receives only a paged, frozen source history and a decision tool. The service
withholds the work environment and excludes ordinary extensions, mutable
instructions, and business tools. Reviewer model, instructions, source boundary,
and retry policy are persisted before the first request. Changing deployment
defaults does not change an existing review.

A proposal is separate from a verified decision. Completion evidence must have
been inspected through the review history tool, satisfy the original contract,
and pass execution's provenance checks. The proposal remains recorded if its
submitting tool fails; only a successful final tool receipt can verify it. A model
failure or missing decision schedules another attempt in the same review
conversation, under the original review identity and current task authority.
The work conversation is not run again. Each retry has a durable submission
identity, and the native scheduler retains its deadline across process restart.
Owner input does not hide unresolved authority or dependency blocks.

When embedding `GoalEngine` directly instead of `AgentService`, install all
`engine.extensions`, supply `settings: () => engine.settings(registry)` to the
harness, and withhold the work environment whenever `engine.isReview` is true.
`AgentService` supplies these boundaries automatically.

The native durable task checkpoints and goal documents reconstruct pending work on
reopen. Questions retain their identities. Stop reconciliation retains its original
intent across observation failures. Active-goal accounting is transactional;
unfinished or faulted work is never inferred idle from a missing running task.
Waiting goals conservatively remain active until a host can prove safe suspension.

The execution store, registry, and trusted adapters must remain outside user tool
access. This module does not enforce storage freshness, process fencing, filesystem
isolation, network isolation, or a supervisor that survives complete controller
outage. Those remain host and resource-provider responsibilities.

Model review remains fallible and needs domain-specific evaluation and human
calibration. It cannot replace actual resource checks, business approvals, or
artifact verification. Model-provider billing is outside the execution store's
transaction: a provider response lost before durable recording may incur another
charge during recovery. No exactly-once model-billing guarantee is made.

## Verification

`tests/goals-store.spec.ts` exercises real SQLite admission and reopen.
`tests/goals-engine.spec.ts` runs the actual durable scheduler with deterministic
model responses, including post-run failure, authority replacement, review retry,
evidence provenance, questions, and stop reconciliation. Rust interoperability
tests use the real service and include killing and restarting its process with a
pending question. They do not validate paid model quality, cloud deployment, or
the host's authority and resource adapters.

`tests/goals-service.spec.ts` exercises authenticated WebSocket clients, refusing
direct execution in goal conversations and cross-owner goal and cursor access.
`tests/goals-review.spec.ts` exercises the built-in reviewer, protected inputs,
proposal receipts, and transient recovery using real SQLite and deterministic
models. Native interoperability also kills the process during a model response
and during a persisted retry wait, then checks the original source, model and
conversation without rerunning the worker.
