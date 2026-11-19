# Protected execution storage

This independent native workspace supplies an encrypted, disk-backed connection
to the existing execution storage interface. The execution schema, transaction
logic, history cursors and task journal remain owned by the execution library.

The connection owns an operating-system writer lock. Database work and content
verification run on a dedicated thread; the runtime binding copies mutable
binary inputs before dispatch and applies the host's explicit queue policy.
Pager and lock-wait settings are optional host configuration, without overriding
the database engine's defaults when absent.

Each transaction records a commitment to the store identity, sequence, schema
and actual row content. Ordinary changes update only affected content-index
paths. Structural migrations rebuild the index by streaming actual rows; old
index versions are pruned in the same transaction. Opening verifies actual data
against the index, so recovery work still grows with retained history.

The adapter orders durable acceptance as follows:

1. Write data and its content commitment in one local transaction.
2. Prepare that exact successor in the host's independent freshness record.
3. Commit the encrypted local database with full synchronous durability.
4. Confirm the original operation with the host.
5. Return success to the execution library.

Uncertain outcomes freeze the adapter. Reopening verifies actual local content
and reconciles the original pending operation, including its original writer
generation. The host must independently fence previous writers, protect keys and
storage from tools, authenticate callers and provide durable metadata. Local
encryption, a process lock and a stored sequence do not establish those guarantees.
The filesystem must provide reliable local locking and synchronous durability;
network filesystems and object stores do not provide an interchangeable backend.

Only ordinary tables with declared non-null primary keys can use incremental
capture. Virtual tables, generated columns, nullable keys and automatic sequence
tables are refused. Application SQL cannot change transaction boundaries, access
protected metadata or disable durability settings. Missing files are never
implicitly initialized; creation requires an explicit protected initialization.

Protected initialization is separate from ordinary opening. The admitted original
initializer may complete an empty file left before its first transaction committed.
Internal schema and genesis metadata commit atomically. Nonempty databases are
verified, never cleared; a missing independent record cannot be recreated for
existing execution history. Legacy snapshots require an explicit migration.

The operator entry is `chopin initialize --config initialization.json`. Its version
1 nonsecret configuration contains `operationId`, separate absolute `volume` and
`home` locations, a `control` binding (`url`, `agentId`, `epoch`, `owner`), and
`storage.queueCapacity`. Optional transport timeouts, response budgets, certificate
authority files, pager settings and the native module location are explicit host
configuration. Inject the control credential through `CHOPIN_CONTROL_TOKEN`.
The command obtains the original key from current host authority, initializes and
closes storage, and only then publishes the host's custody receipt. It starts no
execution service. Repeating it verifies existing data and returns the same receipt.

Build and run the native integration checks from the repository root:

Native builds require a C toolchain, make, Perl and a discoverable libclang.
The SQLCipher session bindings use bindgen during compilation; libclang is not a
runtime dependency. Set `LIBCLANG_PATH` when the compiler library is installed
outside bindgen's search paths.

```sh
pnpm storage:build
pnpm storage:test
cargo test --locked --manifest-path crates/storage/Cargo.toml --target-dir target/storage
cargo clippy --locked --manifest-path crates/storage/Cargo.toml --target-dir target/storage --workspace --all-targets -- -D warnings
RUSTDOCFLAGS='-D warnings' cargo doc --locked --manifest-path crates/storage/Cargo.toml --target-dir target/storage --workspace --no-deps
```

The native runtime checks require the built artifact. They are opt-in during the
ordinary JavaScript test run; `storage:test` explicitly builds and enables them.
Their injected host callbacks test protocol ordering and faults, not production
host authorization or metadata durability. Real host, process interruption,
platform builds, initialization, migration and equivalent-load performance need
their own integration evidence. These checks do not establish full product readiness.
