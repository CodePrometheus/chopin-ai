# Hosted execution process

`chopin cloud --config runtime.json` serves one execution instance admitted by a
trusted host. The host supplies the protected workspace, command worker, custody,
current authority, freshness anchors and recovery supervision. Initialization is a
separate `chopin initialize` operation; ordinary cloud startup never creates a
missing vault, execution database or freshness record.

The version 1 configuration is exported as `CloudConfigurationSchema`. It contains
the fixed control and command bindings, existing sealed volume and restored home,
native storage options, model and review-model selections,
listener address, `keySource` (`provided` or `custody`), and explicit observation
and synchronization policies. Keep the
restored home on a private memory filesystem, separate from the sealed volume and
untrusted workspace. The host must provide and verify those mounts.

Supply these credentials through the trusted process environment, not the JSON
configuration or command arguments:

- `CHOPIN_SERVICE_KEY`: a canonical unpadded base64url key, required only with `keySource: "provided"`.
- `CHOPIN_CONTROL_TOKEN`: the current runtime's protected control credential.
- `CHOPIN_JOB_TOKEN`: the purpose-bound command broker credential.
- `CHOPIN_TOKEN`: the incoming controller connection credential for this owner.

A managed launcher can supply `CHOPIN_AGENT_ID`, `CHOPIN_RUNTIME_EPOCH`, and
`CHOPIN_CONTROL_URL` as an independent allocation binding. When any is present,
the CLI requires all three to match the configuration before reading credentials
or contacting a host.

With `keySource: "custody"`, do not supply `CHOPIN_SERVICE_KEY`. The process uses
its private control binding to request the current execution key. The host must
explicitly enable custody release and independently verify the exact physical
writer and protected resource binding on every request. Initialization and
migration credentials cannot use this endpoint; neither can a draining writer.
Key release does not authorize model calls or resume scheduling.

The process consumes and clears a provided `CHOPIN_SERVICE_KEY`. It restores the existing
vault, verifies native encrypted data against trusted freshness, and only then
loads model configuration and credentials from the restored home. Dedicated cloud
and initialization commands do not read ambient owner proxy settings first. Model
proxy configuration is applied after restoration; control and command transports
retain their independent private dispatchers. Credentials never enter command
arguments or the untrusted workspace through this entry point.

The service initially keeps scheduling paused and reports its listening port
without printing a credential. The host confirms resource and execution readiness,
then resumes through the authenticated goal protocol. Initial restoration is not
execution admission. A durable host recovery fallback must be armed before tasks
are enabled; wake publications alone do not prove a safe resource shutdown.

Protected workspace commands use `CommandJobs`. The cloud process does not start
or connect to a generic execution daemon. Direct shell and command-backed MCP
servers require a separate workspace provider and are unavailable in this entry
point. The host controls tool endpoints. Clients cannot register an MCP server
on the protected service. New effects check current
authority while recovered effects retain their original operation and policy.
Goal completion uses the configured private reviewer and actual external-operation
reconciliation. A normal process shutdown drains local activity and seals updated
home metadata; it does not invent a successful result or restart an accepted command.

## Personal model credentials

Set `personalModels: true` to enable owner-managed API keys. The configured
`model` and `reviewModel` still select the execution and private review models.
The listener starts with an empty usable catalog when there is no personal
authorization. It lists the registered selections that support key-authenticated
chat requests. The hosted adapters support the completions, responses, and
messages APIs with a provider API key.

Point `control.url` at the trusted HTTPS control endpoint. Configure `control.caFile`
when it has a private trust root. The owner settings client sends an operation
identifier on `chopin.credentials`. The execution process claims the change once
over that authenticated HTTPS connection. The host binds the claim to the
admitted writer, owner, and operation. The process serializes changes from claim
through durable acknowledgement. Query the same resource's `snapshot()` after a
lost acknowledgement to read the current credential metadata.

Keys are authenticated and encrypted on the protected volume. Execution and
private review resolve the current key for each request and use it only in the
provider's authentication header. An acknowledged removal makes the next request
require a personal key. Fixed-credential configurations continue to use their
existing model runtime.

## Embedding the hosted runtime

Install matching versions of the CLI and adapter. An embedding application can
import the hosted runtime by its public package path.

```ts
import { openCloudRuntime, type CloudConfiguration } from "chopin-ai/cloud";
```

The host supplies model access, current authorization, workspace and worker
provisioning, separate protected mounts, and a recovery supervisor. The CLI
accepts the same configuration through `chopin cloud --config`.

The npm packages contain JavaScript and type declarations. Encrypted hosted
storage requires a native module for the target operating system and architecture.
The service image below builds it automatically. For a direct npm installation,
build it on the target platform from the same source tag:

```sh
git clone --depth 1 --branch v0.7.0-rc2 https://github.com/CodePrometheus/chopin-ai.git
cd chopin-ai
node scripts/build-storage.mjs
```

Install the resulting `packages/harness-pi/native/chopin-storage.node` alongside
the trusted host. Set `storage.nativeModule` to its absolute installed path in
both the initialization and execution configurations. The build needs the pinned
Rust toolchain, a C toolchain, make, Perl and a discoverable libclang. Embedders
can consume the Rust `chopin-protocol` and `chopin-job-broker` crates from the
same Git tag. Build the worker on Linux with
`cargo build --release --locked -p chopin-job-broker --features worker-service --bin chopin-job-worker`.
The worker's additional supervisor, launcher and isolation requirements are in
the [worker guide](https://github.com/CodePrometheus/chopin-ai/blob/v0.7.0-rc2/crates/job-broker/worker.md).

## Service image

Build from the repository root with the committed dependency lockfiles:

```sh
docker build --file apps/tui/image/Dockerfile --tag chopin-cloud .
```

The build compiles the native storage module for the image platform and the
TypeScript service separately. Its final stage installs only the command's
production dependency closure and runs as `node`. Network-disabled checks verify
the native ABI and refusal to start without trusted configuration. They do not
initialize an agent or call a model. Base-image digests and package-manager version
are explicit build arguments.

Supply the admitted `--config` path, protected credentials and separate host-managed
mounts when launching the image. Put restored home on private memory storage.
The image serves the durable harness; its command worker and provisioning host
remain separate services. Building an image does not authorize execution or
establish persistent-volume fencing.

The cloud image defaults to `cloud --supervise`. Launch the hosted workload with
`cloud --supervise --config runtime.json` and a custody configuration. It runs
one service child at a time in the current allocation. If the restored child
exits without a shutdown request, the supervisor opens the same frozen
configuration in a new child. The child requests custody again and starts
paused. The host uses current authority to resume it. A changed configuration
or a failure before restoration ends the supervisor with an error and leaves
Pod recovery to the host. `SIGTERM` or `SIGINT` to the supervisor stops recovery,
forwards `SIGTERM` to the service, and waits for it to exit.

For an interruption check, use the service PID from the latest restored event.
Observe the service and its independent command worker separately. The
supervisor writes JSON records with `source: "cloud-supervisor"`, their child
`pid` and `attempt`, the UTC observation `at`, and monotonic `elapsedMs` since
supervision started. An unexpected `exited` record and the `restored` record for
the next attempt bound the observed service gap in one container. `restored`
means the new listener is up with the scheduler paused. Match the worker's
independently timed observations within the gap and verify the original
operation through its durable receipt and output.
