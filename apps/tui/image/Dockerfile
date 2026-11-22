ARG NODE_IMAGE=node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ARG RUST_IMAGE=rust:1.100.0-slim-bookworm@sha256:7c7d4eb4d05b7781187a327809466cfddf29753f6defdc3d19a0e291951b7a37

FROM scratch AS qwen-amd64
ADD --checksum=sha256:4058d50847d01d864eb37b856711dbaee7e7deed7ad9278565b692e5773e0fae \
    https://github.com/QwenLM/qwen-code/releases/download/v0.28.3/qwen-code-linux-x64.tar.gz /qwen-code.tar.gz

FROM scratch AS qwen-arm64
ADD --checksum=sha256:bea39bd732c1c9cbc1054da1f9f6c7a28848e8e72fb916b7eade488aa36b7e38 \
    https://github.com/QwenLM/qwen-code/releases/download/v0.28.3/qwen-code-linux-arm64.tar.gz /qwen-code.tar.gz

FROM qwen-${TARGETARCH} AS qwen-archive
FROM ${NODE_IMAGE} AS qwen-client
RUN --network=none --mount=type=bind,from=qwen-archive,source=/qwen-code.tar.gz,target=/tmp/qwen-code.tar.gz \
    tar --extract --gzip --file=/tmp/qwen-code.tar.gz --directory=/opt --no-same-owner

FROM ${RUST_IMAGE} AS native
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends perl make libclang-dev
WORKDIR /source
COPY crates/storage/ crates/storage/
RUN --mount=type=cache,id=chopin-native-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=chopin-native-${TARGETARCH},target=/native-target,sharing=locked \
    cargo build --locked --manifest-path crates/storage/Cargo.toml --target-dir /native-target -p chopin-storage-node --release \
    && mkdir /native-output \
    && cp /native-target/release/libchopin_storage_node.so /native-output/chopin-storage.node

FROM ${NODE_IMAGE} AS manifests
ARG PNPM_VERSION=12.4.1
RUN npm install --global --ignore-scripts --no-audit --no-fund pnpm@${PNPM_VERSION}
WORKDIR /app
COPY --chmod=0644 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=0644 packages/core/package.json packages/core/package.json
COPY --chmod=0644 packages/workspace/package.json packages/workspace/package.json
COPY --chmod=0644 packages/harness-pi/package.json packages/harness-pi/package.json
COPY --chmod=0644 packages/harness-dsh/package.json packages/harness-dsh/package.json
COPY --chmod=0644 apps/tui/package.json apps/tui/package.json

FROM manifests AS compiled
RUN --mount=type=cache,id=chopin-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/tui/ apps/tui/
RUN pnpm build

FROM manifests AS production
RUN --mount=type=cache,id=chopin-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm --filter=chopin-ai... install --store-dir=/pnpm/store --prod --frozen-lockfile --ignore-scripts

FROM production AS runtime
COPY --from=qwen-client /opt/qwen-code/ /opt/qwen-code/
COPY --from=compiled /app/packages/core/dist/ packages/core/dist/
COPY --from=compiled /app/packages/workspace/dist/ packages/workspace/dist/
COPY --from=compiled --chmod=0755 /app/packages/workspace/loopback-listener.sh packages/workspace/loopback-listener.sh
COPY --from=compiled /app/packages/harness-pi/dist/ packages/harness-pi/dist/
COPY --from=compiled /app/apps/tui/dist/ apps/tui/dist/
COPY --from=native --chmod=0444 /native-output/chopin-storage.node packages/harness-pi/native/chopin-storage.node
RUN chmod -R a+rX /app
USER node
RUN --network=none qwen_version="$(/opt/qwen-code/bin/qwen --version)" && test "$qwen_version" = "0.28.3"
RUN --network=none node -e 'const binding = require("/app/packages/harness-pi/native/chopin-storage.node"); if (typeof binding.openNativeStore !== "function") throw new Error("native storage ABI is unavailable");'
RUN --network=none node -e 'const {spawnSync} = require("node:child_process"); const result = spawnSync(process.execPath, ["/app/apps/tui/dist/bin.js", "cloud", "--supervise"], {encoding:"utf8"}); if (result.error || result.status !== 1 || result.stdout !== "" || !result.stderr.includes("--config")) throw new Error("cloud CLI did not require its trusted configuration");'
ENTRYPOINT ["node", "/app/apps/tui/dist/bin.js"]
CMD ["cloud", "--supervise"]
