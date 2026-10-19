# A workspace where dsh runs next to the work, with this adapter mounted in a profile named `chopin`.
FROM node:24-bookworm
ARG DSH_VERSION
ENV DSH_HOME=/opt/dsh
RUN npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" pnpm@12 \
  && dsh --profile chopin --from-default-profile headless --help > /dev/null
COPY --from=packages . /opt/chopin/packages/
COPY profile/ /opt/chopin/profile/
RUN cd "$DSH_HOME/profiles/chopin" \
  && cat /opt/chopin/profile/pnpm-workspace.yaml >> pnpm-workspace.yaml \
  && cp /opt/chopin/profile/cordis.patch.yml cordis.patch.yml \
  && dsh plugin --profile chopin add /opt/chopin/packages/chopin-ai-harness-dsh.tgz \
  && mkdir -p /opt/chopin/layer
WORKDIR /workspace
CMD ["sleep", "infinity"]
