import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { PersonalCredentials } from "../src/personal-credentials.js";
import { personalModels } from "../src/personal-models.js";

const cases = [
  { api: "openai-completions", provider: "openai", base: "/v1", path: "/v1/chat/completions", header: "authorization", bearer: true },
  { api: "openai-responses", provider: "openai", base: "/v1", path: "/v1/responses", header: "authorization", bearer: true },
  { api: "anthropic-messages", provider: "anthropic", base: "", path: "/v1/messages", header: "x-api-key", bearer: false },
];

it.each(cases)("uses only the sealed key on $api requests and masks provider errors", async ({ api, provider, base, path, header, bearer }) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-model-wire-"));
  const key = randomUUID();
  const configured = randomUUID();
  const ambient = randomUUID();
  const overridden = randomUUID();
  const secrets = [key, configured, ambient, overridden];
  const mentionsKey = (text: string) => secrets.some((value) => text.includes(value));
  const calls: { path: string | undefined; usedPersonalKey: boolean; otherAuth: boolean; keyInBody: boolean }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      calls.push({
        path: request.url,
        usedPersonalKey: request.headers[header] === (bearer ? `Bearer ${key}` : key),
        otherAuth: request.headers[bearer ? "x-api-key" : "authorization"] !== undefined,
        keyInBody: mentionsKey(Buffer.concat(chunks).toString()),
      });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: `rejected credential ${request.headers[header]}` },
      }));
    })().catch(() => response.destroy());
  });
  const store = new PersonalCredentials(join(directory, "sealed"), randomBytes(32), "fixture-agent", "fixture-owner");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    vi.stubEnv("OPENAI_API_KEY", ambient);
    vi.stubEnv("ANTHROPIC_API_KEY", ambient);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", ambient);
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({
      providers: { [provider]: {
        api, apiKey: configured, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}`,
        headers: { Authorization: `Bearer ${configured}`, "x-api-key": configured },
        models: [{ id: "fixture-model" }],
      } },
    }));
    const catalog = await ModelRuntime.create({ modelsPath, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    const models = personalModels(catalog, [{ provider, modelId: "fixture-model" }], store);
    const model = models.getModel(provider, "fixture-model")!;
    expect(model).toBeDefined();
    const conversation: Context = { messages: [{ role: "user", content: "Fixture text", timestamp: 1 }] };
    const request = () => models.completeSimple(model, conversation, {
      apiKey: overridden, headers: { Authorization: `Bearer ${overridden}`, "x-api-key": overridden },
    });

    expect(await models.getAvailable()).toEqual([]);
    expect((await request()).stopReason).toBe("error");
    expect(calls).toEqual([]);

    await store.modify(provider, async () => ({ type: "api_key", key }));
    const failure = await request();
    expect(failure.stopReason).toBe("error");
    expect(failure.errorMessage).toBe("the model provider request failed");
    expect(mentionsKey(JSON.stringify(failure))).toBe(false);
    const observed = [{ path, usedPersonalKey: true, otherAuth: false, keyInBody: false }];
    expect(calls).toEqual(observed);

    await store.delete(provider);
    expect((await request()).stopReason).toBe("error");
    expect(calls).toEqual(observed);
  } finally {
    vi.unstubAllEnvs();
    await store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
