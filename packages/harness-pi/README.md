# Durable agent service

`@chopin-ai/harness-pi` supplies `AgentService`, authenticated service hosting,
the client protocol, an ACP bridge, and encrypted-store and key helpers.
It requires Node.js 26.1 or later.

An embedded host can configure [durable goals](goals.md) through
`AgentServiceOptions.goals`. The host supplies current authority and actual
external-operation reconciliation, and selects the built-in review model or a
trusted custom reviewer. Review, history, and stop recovery retain their original
identities across process restart. The command-line service does not configure
cloud adapters automatically.

Use `@chopin-ai/harness-pi/protocol` for clients and
`@chopin-ai/harness-pi/keys` for client-side key handling. Server and client
protocol implementations must be upgraded together. `serveAcp` returns the
current ACP SDK's `AgentConnection`; its `closed` promise includes bridge cleanup.

The service does not isolate arbitrary in-process extensions. Hosts must provide
independent tool protection domains, resource authorization, storage freshness,
and writer fencing. Deterministic protocol and recovery checks do not establish
model quality or a complete cloud deployment.

Source, development instructions, and the changelog are in the
[repository](https://github.com/CodePrometheus/chopin-ai).
