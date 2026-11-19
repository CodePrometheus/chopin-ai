import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Command } from "@chopin-ai/core";
import { errorText } from "@chopin-ai/harness-pi/protocol";
import { Value } from "typebox/value";
import { CloudConfigurationSchema, openCloudRuntime, type CloudRuntime } from "./cloud.js";
import { chopinModels } from "./credentials.js";
import { useConfiguredProxy } from "./network.js";

export const cloudCommand: Command = {
  name: "cloud", args: "--config <file>",
  summary: "serve an admitted cloud execution instance with existing protected storage",
  run: async (args, io) => {
    let runtime: CloudRuntime | undefined;
    let key: Buffer | undefined;
    try {
      const { values } = parseArgs({ args: [...args], options: { config: { type: "string" } } });
      if (values.config === undefined) throw new Error("--config must name the trusted cloud configuration");
      let config: unknown;
      try { config = JSON.parse(await readFile(values.config, "utf8")); }
      catch { throw new Error("the cloud configuration must be readable JSON"); }
      if (!Value.Check(CloudConfigurationSchema, config)) throw new Error("the cloud configuration does not satisfy its versioned contract");
      const required = (name: string) => { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; };
      if (config.keySource === "provided") {
        const encoded = required("CHOPIN_SERVICE_KEY"); key = Buffer.from(encoded, "base64url");
        if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("CHOPIN_SERVICE_KEY must contain the protected runtime key");
      } else if (process.env.CHOPIN_SERVICE_KEY !== undefined) throw new Error("custody unlock cannot also receive CHOPIN_SERVICE_KEY");
      delete process.env.CHOPIN_SERVICE_KEY;
      const stop = Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
      runtime = await openCloudRuntime(config, { serviceKey: key, controlToken: required("CHOPIN_CONTROL_TOKEN"), jobToken: required("CHOPIN_JOB_TOKEN"), launchToken: required("CHOPIN_TOKEN") }, {
        models: async (home) => { process.env.CHOPIN_HOME = home; await useConfiguredProxy(); return chopinModels(undefined, (notice) => io.err(`chopin cloud: ${notice}`)); },
        report: (error) => io.err(`chopin cloud: ${errorText(error)}`),
      });
      io.out(JSON.stringify({ state: "restored", startupPaused: true, port: runtime.server.port }));
      await stop;
      return 0;
    } catch (error) { io.err(`chopin cloud: ${errorText(error)}`); return 1; }
    finally { key?.fill(0); await runtime?.close(); }
  },
};
