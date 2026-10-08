import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { SourceAdapter } from "./adapter.js";
import { createGithubAdapter } from "./github.js";
import { createLokiAdapter } from "./loki.js";
import { createSentryAdapter } from "./sentry.js";

/**
 * Declarative source list (modeled on toolset): the data may be spread across many
 * systems, but onboarding is centralized in one sources.yaml. A new source = one more
 * config block; a transport change (say Loki direct to Grafana proxy) = one url edit.
 * Secrets stay out of the YAML: string values support ${ENV_VAR} expansion from the environment.
 */

export type SourceConfig =
  | { kind: "github-issue"; repo: string }
  | {
      kind: "loki";
      url: string;
      query: string;
      windowMinutes: number;
      minScore: number;
      userField?: string;
      headers?: Record<string, string>;
    }
  | { kind: "sentry"; org: string; project: string; minEvents: number; maxRows?: number };

/** Recursively expand ${ENV_VAR} in strings; unset variables are left as is (so the probe fails naturally and visibly). */
function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    // Supports ${VAR} and ${VAR:-default}: the env var wins, the literal default fills in when
    // unset, so the shipped config works out of the box and each person can still override it.
    return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (raw, name: string, fallback?: string) => {
      const fromEnv = process.env[name];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      return fallback !== undefined ? fallback : raw;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

export async function loadSourceConfigs(filePath: string): Promise<SourceConfig[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const raw = expandEnv(parse(text)) as { sources?: SourceConfig[] };
  return raw.sources ?? [];
}

export function buildAdapters(configs: SourceConfig[]): SourceAdapter[] {
  return configs.map((config) => {
    switch (config.kind) {
      case "github-issue":
        return createGithubAdapter(config);
      case "loki":
        return createLokiAdapter(config);
      case "sentry":
        return createSentryAdapter(config);
      default:
        throw new Error(`unknown source kind: ${(config as { kind: string }).kind}`);
    }
  });
}
