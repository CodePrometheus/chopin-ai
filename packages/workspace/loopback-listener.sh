#!/bin/sh
# Serves this workspace to an agent service beside it on the same network, as LoopbackWorkspaceProvider reaches it:
#   loopback-listener.sh <port> <daemon>
# Each connection starts the execution daemon with the connection as its standard input and output, under the token
# the connection's first line carries; one that sends nothing was only checking the listener is up. It listens on the
# loopback address alone, which nothing outside this network can reach. The daemon's path, and this script's, have no
# space, colon or comma, which the relay's addresses would split on.
set -eu
if [ "${1-}" = --connection ]; then
  read -r token || exit 0
  case $token in '' | *[!0-9a-f]*) exit 2 ;; esac
  exec "$2" serve --token "$token"
fi
case ${1-}:${2-} in '' | :* | *[!0-9]*:* | *:) echo "usage: loopback-listener.sh <port> <daemon>" >&2; exit 2 ;; esac
# Once a connection stops sending, the daemon is given time to answer what it was asked; it ends sooner by itself.
exec socat -t 10 "TCP-LISTEN:$1,bind=127.0.0.1,reuseaddr,fork" "EXEC:$0 --connection $2"
