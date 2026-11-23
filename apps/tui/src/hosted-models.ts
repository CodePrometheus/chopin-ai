import type { AnyModel, Models } from "@earendil-works/pi-ai";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";

export function hostedProviderAllowed(provider: string): boolean {
  return provider !== CODEX_PROVIDER;
}

function hostedModelAllowed(model: AnyModel): boolean {
  return hostedProviderAllowed(model.provider) && model.api !== CODEX_API;
}

function requireHosted<T extends AnyModel>(model: T): T {
  if (!hostedModelAllowed(model)) throw new Error("the model is not available in hosted workspaces");
  return model;
}

/** Keep the fixed provider behavior for hosted models while excluding personal Codex account use. */
export function hostedModels(models: Models): Models {
  const allowedProvider = (id: string) => hostedProviderAllowed(id) &&
    !models.getAllModels(id).some((model) => model.api === CODEX_API);
  const availableProviders = (id?: string) => (id === undefined ? models.getProviders().map(({ id }) => id) : [id]).filter(allowedProvider);
  const allowedModel = (model: AnyModel) => hostedModelAllowed(model) && allowedProvider(model.provider);
  const checked = <T extends AnyModel>(model: T | undefined): T | undefined =>
    model !== undefined && allowedModel(model) ? model : undefined;
  const requireModel = <T extends AnyModel>(model: T): T => {
    if (!allowedProvider(model.provider)) throw new Error("the provider is not available in hosted workspaces");
    return requireHosted(model);
  };
  const requireProvider = (id: string): string => {
    if (!allowedProvider(id)) throw new Error("the provider is not available in hosted workspaces");
    return id;
  };

  return {
    getProviders: () => models.getProviders().filter(({ id }) => allowedProvider(id)),
    getProvider: (id) => allowedProvider(id) ? models.getProvider(id) : undefined,
    getModels: (provider) => models.getModels(provider).filter(allowedModel),
    getModel: (provider, id) => allowedProvider(provider) ? checked(models.getModel(provider, id)) : undefined,
    getModelsOfType: (type, provider) => models.getModelsOfType(type, provider).filter(allowedModel),
    getModelOfType: (type, provider, id) => allowedProvider(provider) ? checked(models.getModelOfType(type, provider, id)) : undefined,
    getAllModels: (provider) => models.getAllModels(provider).filter(allowedModel),
    refresh: (options) => models.refresh({ ...options, providers: options?.providers?.filter(allowedProvider) ?? availableProviders() }),
    checkAuth: async (id, options) => allowedProvider(id) ? models.checkAuth(id, options) : undefined,
    getAvailable: async (id, options) => (await Promise.all(availableProviders(id).map((id) => models.getAvailable(id, options)))).flat().filter(allowedModel),
    getAvailableOfType: async (type, id, options) => (await Promise.all(availableProviders(id).map((id) => models.getAvailableOfType(type, id, options)))).flat().filter(allowedModel),
    getAllAvailable: async (id, options) => (await Promise.all(availableProviders(id).map((id) => models.getAllAvailable(id, options)))).flat().filter(allowedModel),
    getAuth: async (provider: string | AnyModel, options?: Parameters<Models["getAuth"]>[1]) =>
      typeof provider === "string"
        ? allowedProvider(provider) ? models.getAuth(provider, options) : undefined
        : allowedModel(provider) ? models.getAuth(provider, options) : undefined,
    login: async (id, ...args) => models.login(requireProvider(id), ...args),
    logout: async (id, ...args) => models.logout(requireProvider(id), ...args),
    stream: (model, ...args) => models.stream(requireModel(model), ...args),
    complete: async (model, ...args) => models.complete(requireModel(model), ...args),
    streamSimple: (model, ...args) => models.streamSimple(requireModel(model), ...args),
    completeSimple: async (model, ...args) => models.completeSimple(requireModel(model), ...args),
    streamDeferred: (model, ...args) => models.streamDeferred(requireModel(model), ...args),
    fetchDeferred: async (model, ...args) => models.fetchDeferred(requireModel(model), ...args),
    cancelDeferred: async (model, ...args) => models.cancelDeferred(requireModel(model), ...args),
    generateImages: async (model, ...args) => models.generateImages(requireModel(model), ...args),
    classify: async (model, ...args) => models.classify(requireModel(model), ...args),
  };
}
