# Protected command transport

`CommandBroker` exposes the Rust command authority's immutable requests,
original-operation snapshots and binary output pages. The application-side
`JobClient` uses a dedicated authenticated HTTP transport; model and plugin proxy
configuration cannot redirect that credential. Generate the concrete Rust wire
fixtures with `cargo run --locked -p chopin-job-broker --example contracts` and
verify the checked-in values with `pnpm jobs:fixtures`.

The caller must durably save an operation UUID and the exact `JobRequest` before
submitting it. A request contains its actual protection domain, original tool or
improvement source, grant revision, arguments, working directory, environment and
execution policy revision. The host validates resources and authority in the
broker transaction. Tool extensions never receive the broker credential.

A failed request may already have committed. The transport performs no automatic
retries: query the same operation, then explicitly reconcile it. Only an
authoritative `get()` response returning `undefined` establishes absence. A
network failure or unavailable response remains unknown. Every snapshot must
match both the configured scope and requested operation.

`cancel()` records stop intent with the original request even before acceptance;
`stop()` addresses an already retained operation. Cancelling a response wait with
an `AbortSignal` does not stop or resubmit the command. Primary process exit,
complete output and a drained process domain remain separate facts. An acceptance
acknowledgement is not a goal result or proof of safe suspension.

Output retains its original channel and arbitrary bytes as canonical unpadded
base64url. Page size is supplied explicitly; the broker applies the original
operation's retained policy. Cursors are opaque and scoped to that operation.
An empty page can still describe incomplete output. Do not construct a new
operation, change the original environment, or invent a successful exit to recover
from an unavailable observation.

## Durable tool contribution

`CommandJobs` contributes replay-safe `command` and `command_output` tools through `extension`. Supply
an authenticated `broker`, an explicit `CommandPolicy`, a trusted `prepare()`
binding and a non-fatal reporter. `CommandPolicySchema`, `CommandInputSchema` and
`CommandResultSchema` are exported for host configuration and typed integration.
`prepare()` supplies the actual goal, protection domain, working directory,
environment-inheritance policy and immutable execution-policy revision.
`GoalEngine.forExecution()` resolves that goal through conversation ancestry.

The tool commits its original operation, arguments, policy and pending-goal
reference together before contacting the broker. The same transaction rechecks
the goal's current grant and stop state. Replayed calls retain their original
binding and output cursor. Recovery does not call `prepare()` again or interpret
a cancelled response wait as permission to start a replacement command.

Decoded output, cursor and completion retire in one commit. A bounded raw text
window and each channel's UTF-8 prefix survive restart; full binary output stays
with the broker. The window uses the configured byte and line budgets rather than
loading all previous output. A complete tool result requires both drained process
state and confirmed complete output. Exit codes, signals and stopped-before-start
remain distinguishable.

`command_output` reads retained pages only from operations belonging to the
current goal. The original command commit retains a small goal-to-operation
association even after pending work retires. Reads use that exact association,
without scanning old tasks or accepting arbitrary operation identifiers.

Pass `operationId`, optionally an original `cursor`, and `encoding` (`utf8` or
`base64url`). The model receives a JSON string and a diagnostic containing the
channel, next cursor and completion flag. Page bytes fit the configured output
window even after JSON escaping. UTF-8 previews can split a character; the
structured result always retains canonical base64url bytes, and base64url display
preserves those bytes for the model. Empty incomplete pages remain readable from
their cursor in a later call.

The read intent and selected page budget are saved before the request. The
returned page is committed before exposure. Interrupted tool recovery returns
that same page, while checking its current goal association again; it does not
fetch a different page after a configuration change. This is bounded pagination,
not a load of the complete log into memory.

The service retains its conversation-mode guard when a trusted host selects an
explicit extension list or an add/remove patch. Read-only conversations can read
their retained command output but cannot start a new command. Current host
authority and task delegation remain independent checks.

Use `AgentServiceOptions.extensions(owner)` to create separate trusted command
contributions for each owner after storage admission. The existing static extension
array remains supported. In `GoalOptions.settled`, pass the execution's
`GoalEngine.store` to `commands.settled(execution, goal, context)`. This checks only
that goal's pending references. A failed native tool retains its original external
intent until cancellation and output are confirmed. One unavailable operation
does not prevent attempts to stop the remaining originals.

Per-owner factories are trusted composition, not untrusted-code isolation. The
default local service still selects its existing coding tools; a managed host must
explicitly select its protected contributions and connect the resource and file
adapters before enabling the complete cloud runtime.
