import { basename, extname } from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { satisfiedTools } from "@chopin/gate";
import { normalizeErrorString } from "@chopin/ledger";

import { normalizeTriggerFacts } from "./selection.js";
import type { TriggerFacts } from "./selection.js";
import { currentRequestEvents } from "./maintenance.js";

export interface PromptIdentity {
  requestId: string;
  prompt: string;
  occurredAt: string;
}

const PATH_ARGUMENT_KEYS = new Set(["path", "file_path", "filePath", "cwd", "workdir", "workDir"]);
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".go": "go",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".ts": "typescript",
  ".tsx": "typescript",
};

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "";
    const value = block as { type?: string; text?: string };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
}

export function latestHumanPrompt(session: Session): PromptIdentity | undefined {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message" || event.data.source.kind !== "user") continue;
    const prompt = textBlocks(event.data.content);
    if (prompt.trim() !== "") {
      return { requestId: event.data.id, prompt, occurredAt: new Date(event.time).toISOString() };
    }
  }
  return undefined;
}

export function currentStepRequestId(agent: Agent, prompt: PromptIdentity): string {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "step/start") return `${agent.id}:${event.data.turn}:${event.data.step}`;
  }
  return prompt.requestId;
}

function mentionedPaths(prompt: string): string[] {
  const paths: string[] = [];
  for (const match of prompt.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1]?.trim();
    if (value !== undefined && (value.includes("/") || extname(value) !== "")) paths.push(value.replaceAll("\\", "/"));
  }
  return paths;
}

function argumentPaths(value: unknown, key?: string): string[] {
  if (typeof value === "string") return key !== undefined && PATH_ARGUMENT_KEYS.has(key) ? [value.replaceAll("\\", "/")] : [];
  if (Array.isArray(value)) return value.flatMap((item) => argumentPaths(item, key));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([childKey, child]) => argumentPaths(child, childKey));
}

function failedErrorKeys(session: Session): string[] {
  const keys: string[] = [];
  for (const event of currentRequestEvents(session)) {
    if (event.type !== "tool/result") continue;
    const result = event.data.message;
    if (result.isError !== true) continue;
    const text = textBlocks(result.content);
    if (text.trim() !== "") keys.push(normalizeErrorString(text).key);
  }
  return keys;
}

function calledPaths(session: Session): string[] {
  return currentRequestEvents(session).flatMap((event) => {
    if (event.type !== "tool/call") return [];
    try {
      const parsed = typeof event.data.arguments === "string" ? JSON.parse(event.data.arguments) : event.data.arguments;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
      return argumentPaths(parsed);
    } catch {
      return [];
    }
  });
}

function languages(paths: readonly string[]): string[] {
  return paths.map((path) => LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]).filter((value): value is string => value !== undefined);
}

export function defaultTriggerFacts(agent: Agent, prompt: string, includeHistory = true): TriggerFacts {
  const cwd = agent.session.header.cwd;
  const route = agent.options;
  const paths = [...mentionedPaths(prompt), ...(includeHistory ? calledPaths(agent.session) : [])];
  return normalizeTriggerFacts({
    repos: cwd === undefined ? [] : [cwd, basename(cwd)],
    taskKinds: agent.id === undefined ? [] : [String(agent.id)],
    paths,
    tools: includeHistory ? [...satisfiedTools(agent.session)] : [],
    errorKeys: includeHistory ? failedErrorKeys(agent.session) : [],
    languages: languages(paths),
    environments: [process.platform, process.env.CI ? "ci" : "local", ...(route?.provider && route.model ? [modelEnvironment(route.provider, route.model)] : [])],
  });
}

export function modelEnvironment(provider: string, model: string): string { return `model:${provider}/${model}`; }
