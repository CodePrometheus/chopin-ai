# A Linux workspace with the usual source tools, plus the execution daemon the agent drives from outside. A service
# in another container of the same pod reaches it by running `loopback-listener <port> /usr/local/bin/pi-env` instead.
FROM buildpack-deps:stable-scm
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*
COPY --from=daemon pi-env /usr/local/bin/pi-env
COPY --from=workspace loopback-listener.sh /usr/local/bin/loopback-listener
WORKDIR /workspace
CMD ["sleep", "infinity"]
