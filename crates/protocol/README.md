# Client protocol

This crate connects native hosts and clients to the durable service. Contract
descriptions are exported from the producer instead of maintained by consumers.
Calls are sequential. A dropped operation invalidates its connection; a failed
observation requires a new snapshot. Neither path retries application methods.
Each fully applied binding or state batch receives one acknowledgement. These
acknowledgements control transport flow, separately from application receipts and goal results.

Receive bounds are configurable through `ConnectionOptions`. Defaults use the
WebSocket library's message bound, plus the producer's untrusted-link defaults
of 16 MiB per wire part and 64 MiB per decoded part.
The caller supplies operation deadlines and owns reconnection and reconciliation.
Unknown outcomes must be queried with the original application request identifier.

The replica applies ordered updates without cloning unchanged history. Each
member has its own path dictionary. Invalid paths, dictionary references, Unicode
transformations, or incomplete state units invalidate the observation instead of
publishing partial state. Rust strings contain Unicode scalar values; unpaired
UTF-16 units are rejected instead of replaced. Observer revisions are local delivery counts, not
durable execution versions or resume cursors. A source document's retirement is
reported without deleting its last value. A failed member or binding invalidates
the aggregate observation; acquiring a new snapshot recovers it.

## Verification

Install the locked dependencies and build the producer before interoperability
tests:

```sh
pnpm install --frozen-lockfile
pnpm protocol:test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
RUSTDOCFLAGS='-D warnings' cargo doc --locked --workspace --no-deps --all-features
```

To intentionally regenerate shared data after a producer change:

```sh
pnpm build
node scripts/protocol-contracts.mjs
node packages/harness-pi/tests/fixtures/protocol-deltas.mjs
```

The shared fixtures use the producer's real delta and binary encoders. Network
tests connect to the real service and reopen its persistent conversations, using
an isolated credential store and deterministic model catalog. They also inject
wire failures on actual connections through an independent producer-codec process.
TLS tests verify trust before authorization
delivery without installing a process-global cryptography provider. Temporary
service data and logs remain available for inspection.

These checks cover transport, replication, conversation history, learning settings,
and durable goal commands and observations. Goal recovery kills and restarts the
real service while preserving the original request, question, and conversation.
The suite also kills the built-in reviewer's process during a request and a
persisted retry wait. Recovery retains its original model and source without
running the worker again. The deterministic fixture supplies test authority;
these checks do not establish production authority, external-operation
reconciliation, process isolation, model quality, or a complete cloud deployment.
See the [goal adapter contract](../../packages/harness-pi/goals.md).
