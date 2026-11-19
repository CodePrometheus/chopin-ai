# Worker hosting

`chopin-job-worker` hosts one durable Linux worker registration. It uses the same
`LocalWorker`, authenticated routes, encrypted journal and original-operation
recovery as an embedded host. It does not provision a sandbox, issue execution
authority, initialize agent storage or run the agent's model loop.

Build the service and its protected helpers together:

```sh
cargo build --locked --release -p chopin-job-broker --features worker-service --bins
```

Run `chopin-job-worker init --config worker.json` once for a new registration.
The private journal directory must already exist with trusted ownership. `init`
refuses existing storage. Subsequent starts use
`chopin-job-worker serve --config worker.json`; `serve` never creates or repairs
a missing journal. Keep the journal on reliable local storage with durable writes.

## Configuration

Version 1 uses camel-case field names and rejects unknown fields. The host supplies
every policy value; the executable supplies no resource or retry defaults.

| Field | Meaning |
| --- | --- |
| `version` | Exactly `1` |
| `worker`, `scope`, `domain` | Fixed nonnil UUIDs for this registration and protection domain |
| `policyRevision` | Host-approved revision required for new commands |
| `callbackBase` | Trusted broker operation directory; callbacks must match its original operation URL |
| `listen` | Private listener socket address |
| `namespace` | Trusted `NamespaceConfig`: launcher, gate, capture, private root, workspace, read-only mounts, network mode and environment |
| `service.maxBodyBytes` | Maximum private control request envelope |
| `service.recoveryPageSize` | Maximum journal records per recovery page |
| `service.recoveryIntervalMs` | Positive fallback interval between recovery scans |
| `requestTimeoutMs` | Positive whole-request callback deadline |
| `responseBytes` | Maximum callback response envelope |
| `retryAfterMs` | Positive transport refusal hint |
| `caFile` | Optional trusted callback certificate authority file |

Supply secrets in the protected service environment, never the JSON file or
command line:

- `CHOPIN_WORKER_JOURNAL_KEY`: canonical unpadded base64url encoding of 32 bytes.
- `CHOPIN_WORKER_OUTPUT_KEY`: a separate 32-byte key in the same encoding.
- `CHOPIN_WORKER_TOKEN`: the dedicated credential registered with the broker.

Initialization requires only the journal key. Serving also requires the output key
and registration credential. Keep original keys available for recovery. The
command namespace receives only the configured environment and admitted request
values. It cannot access the private journal, output records or service credentials.

New admissions verify scope, domain, policy revision and exact callback URL.
Previously admitted commands retain their original namespace profile and callback;
changing configuration does not replace their arguments, process or output.
Callback traffic bypasses ambient proxies, does not follow redirects, and does
not automatically retry an uncertain mutation. The private listener requires its
registration credential; its hosting layer supplies network isolation and TLS.

## Isolation and recovery

`namespace.network` selects `isolated` or `inherited`. `isolated` creates a new
command network namespace; omitted historical profiles retain this behavior.
`inherited` keeps the provider's network and requires independently enforced
provider isolation and outbound access policy. Every reachable local control
service must authenticate requests. An unauthenticated execution daemon must not
be reachable from command namespaces in this mode. A failed isolated launch never
falls back to inherited networking. Original operations retain their selected
mode after configuration changes.

Run as a non-root identity with Linux user, mount, PID and network namespaces,
process descriptors and system-call filtering available. The outer container
profile must permit the inner namespace's private `/proc` mount. A masked outer
proc filesystem can reject an otherwise valid launch. Verify this capability
under the actual deployment profile; a compiler check does not establish it.
Do not remove inner isolation or grant a command the host's control socket to
work around a failed preflight.

Process status must expose `NSpid`, including the descendant namespace process
identifier. Recovery uses it to verify the original namespace init before
signalling or declaring the namespace drained. A runtime that omits this field
does not satisfy the current process-identity contract; a listening controller
or successful namespace creation alone does not establish compatibility.

Recovery requires the original kernel boot and enclosing PID namespace. A
supervisor can restart this controller while released commands and protected
capture continue. Replacing its entire container or machine requires independent
fencing and registration handling; opening the old journal in a new kernel context
is intentionally rejected.

The service watches both HTTP and recovery tasks. SIGINT or SIGTERM stops new
admission, joins active requests and recovery, then closes the journal. An
unexpected hosting-task exit fails the service. Shutdown does not declare a
command complete or cancel an already released process. A separate supervisor is
required to enforce deadlines while the controller itself is unavailable.

## Verification

On a Linux host that satisfies the isolation requirements, build the controller
tests and run them as a non-root user against a dedicated transactional database:

```sh
CHOPIN_TEST_DATABASE_URL="$TEST_DATABASE_URL" cargo test --locked -p chopin-job-broker --features worker-service --test controller -- --ignored --skip service_child
```

The executable cases cover original binary output and environment, duplicate
submission, graceful close and reopen, and controller termination after an output
acknowledgement was withheld. Recovery must retain the exact original process and
perform its workspace effect once. These checks do not establish a complete cloud
agent, live model behavior or replacement-container recovery.
