#!/bin/sh
# Serves this workspace to an agent service beside it on the same network, as LoopbackWorkspaceProvider reaches it:
#   loopback-listener.sh <port> <daemon>
# Each connection starts the execution daemon with the connection as its standard input and output, under the token
# the connection's first line carries; one that sends nothing was only checking the listener is up. It listens on the
# loopback address alone, which nothing outside this network can reach. This script's path has no space, colon or
# comma, which the relay's address would split on, and is short, as the relay bounds an address to about 500 bytes.
set -eu
if [ "${1-}" = --connection ]; then
  daemon=$LOOPBACK_DAEMON
  # What the daemon starts sees none of how it was reached.
  unset LOOPBACK_DAEMON
  read -r token || exit 0
  case $token in '' | *[!0-9a-f]*) exit 2 ;; esac
  exec "$daemon" serve --token "$token"
fi
case ${1-}:${2-} in '' | :* | *[!0-9]*:* | *:) echo "usage: loopback-listener.sh <port> <daemon>" >&2; exit 2 ;; esac
# The daemon's path reaches each connection's handler in its environment, which carries any path, however long.
export LOOPBACK_DAEMON="$2"
# Once a connection stops sending, the daemon is given time to answer what it was asked; it ends sooner by itself.
exec socat -t 10 "TCP-LISTEN:$1,bind=127.0.0.1,reuseaddr,fork" "EXEC:$0 --connection"
