// Run as `commit-until-killed.mjs <store dir> <data dir> <key hex>`: makes conversations in a sealed store, one after
// another, printing each one's id once its commit is acknowledged, until the process is killed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentService, openSealedStore } from "../../dist/index.js";

const [dir, dataDir, keyHex] = process.argv.slice(2);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const service = new AgentService({
  dataDir,
  workspaces: {
    open: (owner) => ({
      owner, root: "/", state: async () => "running",
      start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv) => ({ argv: [...argv], env: {} }),
    }),
    list: async () => [],
  },
  models: () => models,
  agent: { model: { provider: model.provider, modelId: model.id } },
  // Snapshots come often, so a kill lands while one is written as well as mid-commit.
  store: () => openSealedStore({ dir, key: Buffer.from(keyHex, "hex"), snapshotAfterBytes: 4096 }),
});
for (;;) {
  const conversation = await service.newConversation("local", BACKGROUND_CONTEXT);
  process.stdout.write(`${conversation.id}\n`);
}
