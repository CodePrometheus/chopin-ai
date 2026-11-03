#!/usr/bin/env bash
# Runs chopin from this checkout's sources, without a build, in the directory it is called from.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `--import` takes a module specifier, so the hooks are passed as a file URL.
hooks="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$root/scripts/source-hooks.ts")"
exec node --import "$hooks" "$root/apps/tui/src/bin.ts" "$@"
