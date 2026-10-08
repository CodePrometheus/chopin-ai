import { readFile } from "node:fs/promises";
import { isMap, isSeq, parseDocument } from "yaml";

type CatalogModel = { id: string; reasoningEfforts?: Record<string, string> };
const MANAGED_CATALOG = " Managed model catalog; configure the application's catalog policy.";

/** Catalog restrictions become public base configuration; dependency packages and their model data are not rewritten. */
export async function configuredCatalog(path: string): Promise<Record<string, CatalogModel[]>> {
  const policy = JSON.parse(await readFile(path, "utf8")) as {
    providers: Record<string, { excludedModels: string[]; modelOverrides?: Record<string, { thinkingLevelMap: Record<string, string | null> }> }>;
  };
  const { getBuiltinModels, getBuiltinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
  const result: Record<string, CatalogModel[]> = {};
  for (const [provider, settings] of Object.entries(policy.providers)) {
    const providerId = getBuiltinProviders().find(id => id === provider);
    if (!providerId) throw new Error(`Unknown catalog provider ${provider}`);
    const models = getBuiltinModels(providerId);
    if (!models.length || !Array.isArray(settings.excludedModels)) throw new Error(`Invalid catalog policy for ${provider}`);
    const overrides = settings.modelOverrides ?? {};
    for (const id of Object.keys(overrides)) if (!models.some(model => model.id === id)) throw new Error(`Catalog override refers to missing model ${provider}/${id}`);
    result[provider] = models.filter(model => !settings.excludedModels.includes(model.id)).map(model => {
      const override = overrides[model.id];
      if (!override) return { id: model.id };
      const levels = { ...Object.fromEntries(getSupportedThinkingLevels(model).map(level => [level, model.thinkingLevelMap?.[level] ?? level])), ...override.thinkingLevelMap };
      return { id: model.id, reasoningEfforts: Object.fromEntries(Object.entries(levels).filter((entry): entry is [string, string] => entry[1] !== null)) };
    });
  }
  return result;
}

export function applyConfiguredCatalog(source: string, catalog: Record<string, CatalogModel[]>): string {
  const document = parseDocument(source, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (document.errors.length || !isSeq(document.contents)) throw new Error("Invalid profile patch");
  const row = document.contents.items.find(item => isMap(item) && String(item.get("id")) === "llm-pi-ai");
  if (!isMap(row)) return source;
  const config = row.get("config", true);
  if (!isMap(config)) return source;
  const providers = config.get("providers", true);
  if (!isMap(providers)) return source;
  let changed = false;
  for (const [provider, models] of Object.entries(catalog)) {
    const settings = providers.get(provider, true);
    if (!isMap(settings)) continue;
    const previous = settings.get("models", true);
    if (previous && (!isSeq(previous) || previous.commentBefore !== MANAGED_CATALOG)) continue;
    const next = document.createNode(models);
    next.commentBefore = MANAGED_CATALOG;
    if (previous && JSON.stringify(previous.toJSON()) === JSON.stringify(models)) continue;
    settings.flow = false; settings.set("models", next); changed = true;
  }
  return changed ? document.toString() : source;
}
