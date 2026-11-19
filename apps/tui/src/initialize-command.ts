import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Command } from "@chopin-ai/core";
import { errorText } from "@chopin-ai/harness-pi/protocol";
import { ControlConfigurationSchema, ControlHost } from "./control.js";
import { initializeProject } from "./initialize.js";

const positive = Type.Integer({ minimum: 1, maximum: 0xffff_ffff });
export const InitializationConfigurationSchema = Type.Object({
  version: Type.Literal(1), operationId: Type.String({ minLength: 1 }),
  volume: Type.String({ minLength: 1 }), home: Type.String({ minLength: 1 }),
  control: ControlConfigurationSchema,
  storage: Type.Object({
    queueCapacity: positive,
    cacheKiB: Type.Optional(positive),
    busyTimeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffff_ffff })),
    nativeModule: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type InitializationConfiguration = Static<typeof InitializationConfigurationSchema>;

export const initializeCommand: Command = {
  name: "initialize",
  args: "--config <file>",
  summary: "initialize or reconcile protected storage under an existing host admission",
  run: async (args, io) => {
    let configuration: InitializationConfiguration;
    let credential: string;
    try {
      const { values } = parseArgs({ args: [...args], options: { config: { type: "string" } } });
      if (values.config === undefined) throw new Error("--config must name the trusted initialization configuration");
      const text = await readFile(values.config, "utf8");
      let value: unknown;
      try { value = JSON.parse(text) as unknown; }
      catch { throw new Error("the initialization configuration must be valid JSON"); }
      if (!Value.Check(InitializationConfigurationSchema, value)) throw new Error("the initialization configuration does not satisfy its versioned contract");
      configuration = value;
      const token = process.env.CHOPIN_CONTROL_TOKEN;
      if (token === undefined || token === "") throw new Error("CHOPIN_CONTROL_TOKEN is required");
      credential = token;
    } catch (error) { io.err(`chopin initialize: ${errorText(error)}`); return 2; }
    let control: ControlHost | undefined;
    try {
      control = await ControlHost.connect(configuration.control, credential);
      const receipt = await initializeProject({
        ...configuration,
        authority: control.initialization(configuration.operationId),
        storage: { ...configuration.storage, anchor: control.anchors() },
      });
      io.out(JSON.stringify(receipt));
      return 0;
    } catch (error) { io.err(`chopin initialize: ${errorText(error)}`); return 1; }
    finally { await control?.close(); }
  },
};
