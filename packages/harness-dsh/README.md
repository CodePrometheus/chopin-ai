# Plugin harness adapter

`@chopin-ai/harness-dsh` loads a portable mutable layer into the plugin harness,
applies session-derived tool gates, and records ACP-shaped transcripts with
adapter-owned token totals. `@chopin-ai/harness-dsh/run` exposes the headless
workspace runner.

This adapter targets the explicitly declared `0.2.2-rc.3` harness packages. Those
packages are prereleases; the adapter does not turn them into a stable upstream
release. Projection registration is awaited before gates become available, and
the retained projection handle reads the framework's actual session log.

The projection interface declares Zod `4.6.6`, which this adapter pins exactly.
The `4.6.7` upgrade was checked and rejected because its public schema types are
incompatible with that interface. No assertion cast or disabled type check hides
the conflict.

The workspace image and its profile are built from the repository's
`packages/harness-dsh/image` sources. A profile must mount this adapter with its
layer and transcript directories. The adapter supplies no credentials and makes
no guarantee that a model will complete a task.
