# Command coordination

The ledger preserves one immutable command under a stable operation identifier.
The host authenticates its caller and joins current authorization to the same
transaction that records or releases the command. A returned mutation snapshot
is provisional until that transaction commits. Discard a record after a failed
transaction and read the original operation again.

Commit intent and the exact worker reservation before issuing an external call.
Persist stop intent even when cancellation arrives before submission. Keep the
original worker identity across runtime replacement and reconcile uncertain
start or stop responses. Primary process exit, output completion and descendant
drain are distinct facts.

Command content, control state and output frames are authenticated and encrypted
under a dedicated host key. Ciphertexts bind their purpose, operation and revision
or sequence. The host supplies database freshness guarantees. Apply `SCHEMA_V1`
through the host's migration system and use durable transactions with `fsync=on`
and `synchronous_commit=on` or `remote_apply`.

Output frames use a contiguous sequence shared by both channels. Repeating a
sequence succeeds only with identical bytes and channel. Output pages preserve
channel and byte boundaries and return operation-bound cursors, including when
no new bytes are available.
An attached gate can report initialization or refusal diagnostics before release.
Recording those observations never grants execution authority.

`Broker` commits admission, worker reservation and stop intent before contacting
an external worker. Reconciliation resolves the original worker and queries the
original operation. A failed observation remains an error. A durable admission
receipt carries no physical completion claim; process exit and namespace drain
are recorded separately, and drain waits for all output to arrive.

Each operation retains its transport and recovery policy. Reconfiguring the host
changes new admissions; callbacks and output pages keep the original bounds.
`has_pending` checks current scope authority and fails when the store cannot be
observed. `recover` processes a scope-bound source page; the host owns its cadence,
cancellation and task lifetime. Each pass starts at the beginning to discover new
admissions that sort before a previous cursor.

With the `transport` feature, the broker exposes purpose-authenticated routes
relative to its host mount. Engine callers use `PUT /{operation}`, `GET
/{operation}`, `DELETE /{operation}`, `POST /{operation}/cancel`, `POST
/{operation}/reconcile` and `GET /{operation}/output?limit=...&cursor=...`.
Workers use `POST /{operation}/worker`. Responses disable storage in caches.

`ControlClient` preserves the host's TLS configuration and disables redirects and
automatic retries. Worker routes are relative to the directory-provided endpoint:
`PUT`, `GET` and `DELETE` at `/{scope}/{operation}`. A lookup returns a typed
`WorkerLookup`; HTTP 404, malformed JSON and failed connections never establish
absence. Worker observations and callback receipts must match the original scope,
operation and worker. A callback receipt must also contain the fact it acknowledges.

`WorkerJournal` stores authenticated, encrypted local admissions, cancellation
tombstones and original launch and release reservations. `create` exclusively
initializes new storage; `open` never creates missing storage. Reopening checks the
worker, kernel context, directory and database identities. A separate controller
lock and one database connection serialize local changes. The journal uses a
write-ahead log with full synchronous commits and requires reliable local storage;
encryption does not establish storage freshness or make network filesystems suitable.

With both `worker` and `transport`, `LocalWorker` resolves new admissions through
the host's `WorkerPolicy`, exposes dedicated-credential control routes, and
reconciles original processes and outputs. A command passes its gate only after
the broker authorizes the recorded identity. `recover` returns each operation's
actual result, including failures, and `changed` only hints that the journal has
work. The host owns the recovery loop, TLS, supervisor and shutdown sequence.
Closing the controller leaves already released commands and their output capture
running; a deployment supervisor must preserve the enclosing process namespace
if it expects process-level recovery. Changing the kernel context requires separate
fencing and registration rather than silently opening another worker's journal.

The Linux `worker-service` feature includes `chopin-job-worker` and a host-owned
`serve_worker` lifetime. See [worker hosting](worker.md) for configuration,
explicit initialization, recovery boundaries and the executable checks.

The Linux `worker` feature provides the native gate, namespace process handles and
protected output capture. `NamespaceConfig` supplies trusted executables and
mounts. `CaptureOptions` retains the original operation, worker, frame policy and
output key. The host must persist that information before calling `Namespace::spawn`.
The native helpers require user and process namespaces, process descriptors,
system-call filtering and descriptor-based mounts. Missing support is an error.
Environment inheritance uses the original encrypted profile, with explicit request
values taking precedence. The controller's environment is never inherited. Environment
names follow the operating-system contract, and the resolved gate message must fit
the operation's original body policy before admission.

A timeout starts at the first durable release reservation and is measured against
the kernel's boot clock. Reopening does not restart that budget. Control requests
cannot consume the remaining execution budget indefinitely, and stop intent is
persisted before the original namespace is signalled. The host must keep recovery
scheduled; enforcement throughout a complete controller outage still requires an
independent supervisor. An expired budget is not termination evidence.

Commands receive output pipes. A separate protected process encrypts and
synchronizes immutable frames outside the command filesystem; the command cannot
truncate previously captured output. Both pipes must reach EOF before a final
sequence is published. Capture survives controller termination. A capture or
storage failure leaves output incomplete; buffered bytes are not guaranteed to
survive host failure. Never infer completion from process exit alone or replay
the command to replace missing output.

`OutputReader` reopens original records with the retained identity, policy and
key. With `transport` enabled, `deliver` observes the broker's committed prefix
and submits the remaining original frames. It does not start a command or prove
namespace drain. The host owns retry scheduling and cancellation. Product host
lifecycle integration and the complete execution-goal flow remain unfinished.

Run the real transactional checks explicitly against an isolated database:

```sh
CHOPIN_TEST_DATABASE_URL="$TEST_DATABASE_URL" cargo test --locked -p chopin-job-broker --all-features --test ledger --test broker --test http -- --include-ignored
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
RUSTDOCFLAGS='-D warnings' cargo doc --locked --workspace --no-deps --all-features
```

On a Linux host with the native capabilities available, run the namespace checks
as an unprivileged user. Their fixture expects the namespace launcher in its
standard local installation directory and system executables in the standard
system directories. The controller subprocess entry is invoked by its parent
test; do not run every ignored entry indiscriminately.

```sh
cargo test --locked -p chopin-job-broker --all-features --test runtime
cargo test --locked -p chopin-job-broker --all-features --lib runtime::journal::tests
CHOPIN_TEST_DATABASE_URL="$TEST_DATABASE_URL" cargo test --locked -p chopin-job-broker --all-features --test runtime delivery:: -- --ignored
CHOPIN_TEST_DATABASE_URL="$TEST_DATABASE_URL" cargo test --locked -p chopin-job-broker --all-features --test controller -- --include-ignored --skip service_child
```

The tests retain their isolated schemas and filesystem evidence for inspection.
