import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeCommand } from "../src/initialize-command.js";

afterEach(() => vi.unstubAllEnvs());

it("requires explicit versioned configuration without printing invalid file contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chopin-initialize-config-"));
  const file = join(directory, "configuration.json");
  await writeFile(file, '{"synthetic-private-value"');
  const messages: string[] = [];
  const code = await initializeCommand.run(["--config", file], { out: (message) => messages.push(message), err: (message) => messages.push(message) });
  expect(code).toBe(2);
  expect(messages.join("\n")).toContain("valid JSON");
  expect(messages.join("\n")).not.toContain("synthetic-private-value");
});

it("refuses an unversioned configuration before opening storage or contacting a host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chopin-initialize-contract-"));
  const file = join(directory, "configuration.json");
  await writeFile(file, JSON.stringify({ operationId: "unadmitted", volume: directory }));
  const errors: string[] = [];
  expect(await initializeCommand.run(["--config", file], { out: () => { throw new Error("no receipt may be published"); }, err: (message) => errors.push(message) })).toBe(2);
  expect(errors.join("\n")).toContain("versioned contract");
});

it("requires the control credential separately from the nonsecret configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chopin-initialize-credential-"));
  const file = join(directory, "configuration.json");
  await writeFile(file, JSON.stringify({ version: 1, operationId: "synthetic-operation", volume: join(directory, "volume"), home: join(directory, "home"), control: { url: "https://control.example.test/", agentId: "synthetic-agent", epoch: 1, owner: "synthetic-owner" }, storage: { queueCapacity: 1 } }));
  vi.stubEnv("CHOPIN_CONTROL_TOKEN", undefined);
  const errors: string[] = [];
  expect(await initializeCommand.run(["--config", file], { out: () => { throw new Error("no receipt may be published"); }, err: (message) => errors.push(message) })).toBe(2);
  expect(errors.join("\n")).toContain("CHOPIN_CONTROL_TOKEN");
});
