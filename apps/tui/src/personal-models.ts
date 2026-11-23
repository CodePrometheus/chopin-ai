import {
  createModels, createProvider, lazyStream,
  type Api, type AssistantMessageEvent, type CredentialStore, type FetchFunction,
  type Model, type Models, type ProviderStreams, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";

type ModelRef = { provider: string; modelId: string };
type Selected = { model: Model<Api>; name: string; keyName: string; streams: ProviderStreams };
const REQUEST_FAILED = "the model provider request failed";
const ADAPTER_KEY = "sk-service-managed";

/** Only the configured chat models with a verified, header-authenticated transport. */
export function personalModels(catalog: Models, selected: readonly ModelRef[], credentials: CredentialStore): Models {
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const byProvider = new Map<string, Map<string, Selected>>();
  for (const ref of selected) {
    const provider = catalog.getProvider(ref.provider);
    const model = catalog.getModel(ref.provider, ref.modelId);
    if (provider?.auth.apiKey === undefined || model === undefined || modelOrigin(model.baseUrl) === undefined) continue;
    const streams = apiKeyStreams(model.api);
    if (streams === undefined) continue;
    const { headers: _headers, ...allowed } = model;
    if (!byProvider.has(provider.id)) byProvider.set(provider.id, new Map());
    byProvider.get(provider.id)!.set(model.id, { model: allowed, name: provider.name, keyName: provider.auth.apiKey.name, streams });
  }
  for (const [id, entries] of byProvider) {
    const first = entries.values().next().value!;
    const call = (simple: boolean, model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => lazyStream(model, async () => {
      const selected = entries.get(model.id);
      if (selected === undefined) throw new Error("this model is not admitted");
      const guarded = {
        ...options, apiKey: ADAPTER_KEY, env: undefined, headers: undefined,
        onResponse: undefined, onProviderStreamEvent: undefined, telemetry: undefined,
        fetch: boundFetch(selected.model, credentials), transport: "sse" as const,
      };
      try {
        const stream = simple ? selected.streams.streamSimple(selected.model, context, guarded) : selected.streams.stream(selected.model, context, guarded);
        return safeEvents(stream);
      } catch {
        throw new Error(REQUEST_FAILED);
      }
    }, undefined, options?.signal);
    models.setProvider(createProvider({
      id, name: first.name, models: [...entries.values()].map(({ model }) => model),
      auth: { apiKey: { name: first.keyName, resolve: async ({ credential }) =>
        credential?.key ? { auth: { apiKey: ADAPTER_KEY } } : undefined } },
      api: {
        stream: (model, context, options) => call(false, model, context, options),
        streamSimple: (model, context, options) => call(true, model, context, options),
      },
    }));
  }
  return models;
}

function apiKeyStreams(api: Api): ProviderStreams | undefined {
  switch (api) {
    case "openai-completions": return openAICompletionsApi();
    case "openai-responses": return openAIResponsesApi();
    case "anthropic-messages": return anthropicMessagesApi();
    default: return undefined;
  }
}

function modelOrigin(baseUrl: string): string | undefined {
  const url = URL.parse(baseUrl);
  if (url === null || url.username || url.password || url.search || url.hash) return undefined;
  if (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
  return undefined;
}

function boundFetch(model: Model<Api>, credentials: CredentialStore): FetchFunction {
  const origin = modelOrigin(model.baseUrl);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin || url.username || url.password) throw new Error(REQUEST_FAILED);
    const stored = await credentials.read(model.provider, { signal: request.signal });
    if (stored?.type !== "api_key" || !stored.key) throw new Error("a personal API key is required");
    const key = stored.key;
    if ([...url.searchParams.values()].includes(key)) throw new Error(REQUEST_FAILED);
    const headers = new Headers(request.headers);
    for (const header of ["authorization", "x-api-key", "openai-organization", "openai-project"]) headers.delete(header);
    if (model.api === "anthropic-messages") headers.set("x-api-key", key);
    else headers.set("authorization", "Bearer " + key);
    return fetch(request, { headers, redirect: "error" });
  };
}

async function* safeEvents(stream: AsyncIterable<AssistantMessageEvent>): AsyncIterable<AssistantMessageEvent> {
  try {
    for await (const event of stream) {
      if (event.type !== "error") {
        yield event;
        continue;
      }
      const { api, provider, model, usage, timestamp } = event.error;
      yield {
        type: "error", reason: event.reason,
        error: { role: "assistant", api, provider, model, usage, timestamp, content: [], stopReason: event.reason, errorMessage: REQUEST_FAILED },
      };
    }
  } catch {
    throw new Error(REQUEST_FAILED);
  }
}
