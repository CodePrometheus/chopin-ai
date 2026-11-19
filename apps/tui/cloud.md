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

Embedding hosts can call `openCloudRuntime()` with their model library and trusted
verifier. This execution entry does not itself implement cloud provisioning, a
standalone identity service, the command worker's physical isolation, or persistent
volume handoff. Those host services remain required for a complete deployment.

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
