# A Linux workspace with the usual source tools, plus the execution daemon the agent drives from outside.
FROM buildpack-deps:stable-scm
COPY --from=daemon pi-env /usr/local/bin/pi-env
WORKDIR /workspace
CMD ["sleep", "infinity"]
