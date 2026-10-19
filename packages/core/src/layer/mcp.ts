import { createHash } from "node:crypto";
import { isVariableName } from "@chopin-ai/workspace";

/** An MCP server entry, in the `mcpServers` shape most agents already read; both harnesses speak these two transports. */
export type McpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export function parseMcpServers(value: unknown, source: string, problems: string[]): Record<string, McpServer> {
  if (value === undefined) return {};
  const servers = (value as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    problems.push(`${source}: expected an object with mcpServers`);
    return {};
  }
  const parsed: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    const problem = serverProblem(name, server);
    if (problem === undefined) parsed[name] = server as McpServer;
    else problems.push(`${source}: server ${name} ${problem}`);
  }
  return parsed;
}

/**
 * Server names every harness accepts. Without `__` or a trailing `_`, `mcp__<server>__` also names exactly one
 * server in any tool name.
 */
const SERVER_NAME = /^(?!.*__)[A-Za-z0-9_-]{0,31}[A-Za-z0-9-]$/;
/** An HTTP field name: a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function serverProblem(name: string, server: unknown): string | undefined {
  if (!SERVER_NAME.test(name)) return 'needs a name of 1 to 32 letters, digits, "_" or "-", without "__" or a trailing "_"';
  const entry = (typeof server === "object" && server !== null ? server : {}) as Record<string, unknown>;
  if (entry.type === "sse") return "uses SSE, which not every harness speaks; use type http (Streamable HTTP)";
  if (typeof entry.command === "string") {
    if (entry.command === "") return "needs a command";
    if (entry.args !== undefined && !strings(entry.args)) return "needs args as a list of strings";
    if (entry.env !== undefined && !textRecord(entry.env)) return "needs env as an object of string values";
    const env = (entry.env ?? {}) as Record<string, string>;
    const name = Object.keys(env).find((key) => !isVariableName(key));
    if (name !== undefined) {
      return `needs env names of letters, digits and "_", not starting with a digit, other than "_" and those starting with CHOPIN_ENV_, which ${JSON.stringify(name)} is not`;
    }
    if ([entry.command, ...((entry.args ?? []) as string[]), ...Object.values(env)].some(hasNul)) return "holds a NUL character, which no program can be given";
    return undefined;
  }
  if (entry.type === "http" && typeof entry.url === "string") {
    if (!/^https?:$/.test(URL.parse(entry.url)?.protocol ?? "")) return `needs an http or https url, not ${entry.url}`;
    if (entry.headers !== undefined && !textRecord(entry.headers)) return "needs headers as an object of string values";
    const header = Object.keys((entry.headers ?? {}) as object).find((key) => !HEADER_NAME.test(key));
    if (header !== undefined) return `needs header names an HTTP request can carry, which ${JSON.stringify(header)} is not`;
    const value = Object.entries((entry.headers ?? {}) as Record<string, string>).find(([, text]) => /[^\t\x20-\x7e]/.test(text));
    if (value !== undefined) return `needs header values an HTTP request can carry, which that of ${JSON.stringify(value[0])} is not`;
    return undefined;
  }
  return "needs a command, or type http with a url";
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function textRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string");
}

function hasNul(text: string): boolean {
  return text.includes("\0");
}
const NAME_LIMIT = 64;
const INVALID = /[^A-Za-z0-9_-]/g;

/**
 * The model-facing name of an MCP tool, `mcp__<server>__<tool>`, as both harnesses spell it: provider function names
 * allow only `[A-Za-z0-9_-]` and 64 characters, and a name that had to change gains a hash of its identity so two
 * tools never collapse into one. Gate rules name MCP tools this way.
 */
export function mcpToolName(server: string, tool: string): string {
  const joined = `mcp__${server}__${tool}`;
  const normalized = joined.replace(INVALID, "_");
  if (normalized === joined && normalized.length <= NAME_LIMIT) return normalized;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, NAME_LIMIT - 12 - 1)}_${hash}`;
}

/** Whether `tool` names a tool of `server`, a server name the layer accepts. */
export function isMcpToolOf(server: string, tool: string): boolean {
  return tool.startsWith(`mcp__${server}__`);
}
