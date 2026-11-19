import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { AgentService, CommandJobs, CommandPolicySchema, JobIdSchema, launchToken, listen, openEncryptedStore, type GoalOptions, type Listening } from "@chopin-ai/harness-pi";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ControlConfigurationSchema, ControlHost } from "./control.js";
import { InitializationConfigurationSchema } from "./initialize-command.js";
import { JobClient, JobsConfigurationSchema } from "./jobs.js";
import { Vault } from "./vault.js";

const text = Type.String({ minLength: 1 });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const model = Type.Object({ provider: text, modelId: text }, { additionalProperties: false });
export const CloudConfigurationSchema = Type.Object({
  version: Type.Literal(1), purpose: Type.Literal("execution"), keySource: Type.Union([Type.Literal("provided"), Type.Literal("custody")]), volume: text, home: text,
  control: ControlConfigurationSchema,
  jobs: Type.Object({ transport: JobsConfigurationSchema, domain: JobIdSchema, cwd: text, policyRevision: text, inheritEnv: Type.Boolean(), policy: CommandPolicySchema }, { additionalProperties: false }),
  storage: InitializationConfigurationSchema.properties.storage,
  server: Type.Object({ port: Type.Integer({ minimum: 0, maximum: 65535 }), hostname: Type.Optional(text) }, { additionalProperties: false }),
  model, reviewModel: model, goalRetryAfterMs: positive,
  vaultSyncMs: Type.Integer({ minimum: 1, maximum: 0x7fff_ffff }),
}, { additionalProperties: false });
export type CloudConfiguration = Static<typeof CloudConfigurationSchema>;
export interface CloudSecrets { controlToken: string; jobToken: string; launchToken: string; serviceKey?: Uint8Array; }
export interface CloudDependencies {
  /** Called only after the existing encrypted store and trusted freshness have been verified. */
  models(home: string): Promise<Models>;
  /** Trusted embedding hosts may provide an independent verifier; the CLI uses the configured model. */
  review?: GoalOptions["review"];
  report(error: unknown): void;
}
export interface CloudRuntime { service: AgentService; server: Listening; close(): Promise<void>; }

/** Runs one already admitted cloud execution instance; initialization and resource supply belong to its host. */
export async function openCloudRuntime(configuration: CloudConfiguration, secrets: CloudSecrets, dependencies: CloudDependencies): Promise<CloudRuntime> {
  const config = structuredClone(configuration);
  if (!Value.Check(CloudConfigurationSchema, config)) throw new Error("the cloud runtime configuration does not satisfy its versioned contract");
  if (config.jobs.transport.scopeId !== config.control.agentId) throw new Error("the command and control bindings name different agents");
  for (const path of [config.volume, config.home]) if (!isAbsolute(path)) throw new Error("cloud runtime locations must be absolute");
  separate(resolve(config.volume), resolve(config.home));
  if (secrets.launchToken === "" || (config.keySource === "provided" ? secrets.serviceKey?.length !== 32 : secrets.serviceKey !== undefined)) throw new Error("the runtime requires its configured key source and a launch credential");
  let key: Buffer | undefined = secrets.serviceKey === undefined ? undefined : Buffer.from(secrets.serviceKey); secrets.serviceKey?.fill(0);
  let control: ControlHost | undefined; let broker: JobClient | undefined; let vault: Vault | undefined;
  let storage: Awaited<ReturnType<typeof openEncryptedStore>> | undefined;
  let service: AgentService | undefined; let server: Listening | undefined;
  let admitted = false; let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [];
    for (const action of [() => server?.close(), () => service?.close(context), () => storage?.close(context), () => admitted ? vault?.close() : undefined, () => broker?.close(), () => control?.close()]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    key?.fill(0);
    if (failures.length > 0) throw new AggregateError(failures, "the cloud runtime could not close every resource");
  })();
  try {
    control = await ControlHost.connect(config.control, secrets.controlToken);
    const anchor = control.anchors();
    if (await anchor.read() === undefined) throw new Error("cloud execution requires an already initialized freshness record");
    if (config.keySource === "custody") key = (await control.executionKey()).key;
    if (key === undefined) throw new Error("the runtime key source did not release a key");
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    separate(await realpath(config.volume), await realpath(config.home));
    vault = await Vault.openExisting(config.volume, config.home, key);
    const protectedStore = vault.store;
    try { storage = await openEncryptedStore({ ...config.storage, ...protectedStore, anchor }); }
    finally { protectedStore.key.fill(0); }
    const models = await dependencies.models(config.home);
    for (const selected of [config.model, config.reviewModel]) if (models.getModel(selected.provider, selected.modelId) === undefined) throw new Error("a configured execution or review model is not available");
    broker = await JobClient.connect(config.jobs.transport, secrets.jobToken);
    const owner = config.control.owner;
    const requireOwner = (given: string) => { if (given !== owner) throw new Error("this cloud runtime belongs to another execution owner"); };
    let commands: CommandJobs;
    service = new AgentService({
      dataDir: join(config.home, "execution"), startPaused: true, allowClientMcp: false,
      store: async (given) => { requireOwner(given); return storage!; },
      models: (given) => { requireOwner(given); return models; },
      extensions: (given) => {
        requireOwner(given);
        commands = new CommandJobs({ broker: broker!, policy: config.jobs.policy, report: dependencies.report, prepare: async (api, ctx) => ({
          goal: await (await service!.goals(owner)).forExecution(api.conversationId, ctx),
          domain: config.jobs.domain, cwd: config.jobs.cwd, policyRevision: config.jobs.policyRevision, inheritEnv: config.jobs.inheritEnv,
        }) });
        return [commands.extension];
      },
      agent: async (given) => { requireOwner(given); return { model: config.model, cwd: config.jobs.cwd, extensions: [commands.extension] }; },
      goals: (given) => {
        requireOwner(given);
        return { authorize: (request, ctx) => control!.authorize(request, ctx.abortSignal), review: dependencies.review ?? { model: config.reviewModel },
          settled: async (goal, ctx) => commands.settled((await service!.goals(owner)).store, goal, ctx),
          retryAfterMs: config.goalRetryAfterMs, report: dependencies.report,
        };
      },
      onWake: (given, wake) => { requireOwner(given); return control!.publishWake(wake); },
      persist: () => vault!.sync(), report: dependencies.report,
    });
    await service.goals(owner);
    server = await listen(service, { ...config.server, authenticate: launchToken(secrets.launchToken, owner) });
    admitted = true;
    vault.keepSynced(config.vaultSyncMs, dependencies.report);
    return { service, server, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "cloud startup failed and cleanup is uncertain"); }
    throw error;
  }
}

function separate(volume: string, home: string): void {
  if (volume === home || volume.startsWith(`${home}${sep}`) || home.startsWith(`${volume}${sep}`)) throw new Error("the sealed volume and restored home must be separate locations");
}
