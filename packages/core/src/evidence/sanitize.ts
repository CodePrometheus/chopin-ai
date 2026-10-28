import type { McpServer } from "../layer/mcp.js";
import type { TranscriptEntry } from "../transcript.js";

/** Common secret formats: provider keys, access tokens, cloud keys, JWTs and private key blocks. */
const SECRET_FORMATS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?<=\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?)[^\s"']{8,}/gi,
];

/** Files whose whole content is withheld once a tool has read them. */
const SECRET_FILE = /(^|[\s/"'=])(\.env(\.[\w-]+)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)|[\w-]+\.pem|credentials(\.json)?)(?=$|[\s"'])/;

const MASK = "[redacted]";

/** Names under which a value is a secret, as an environment variable or a request header. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE/i;

/** The values of environment variables named like secrets. */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) => value !== undefined && value.length >= 8 && SECRET_NAME.test(name) ? [value] : []);
}

/**
 * The secrets MCP servers are configured with, from headers and environment named like secrets: each whole value and
 * each long word of it, so a token is masked with or without the scheme before it.
 */
export function mcpSecrets(servers: Readonly<Record<string, McpServer>>): string[] {
  return Object.values(servers)
    .flatMap((server) => secretValues("command" in server ? server.env ?? {} : server.headers ?? {}))
    .flatMap((value) => [value, ...value.split(/\s+/).filter((word) => word.length >= 8 && word !== value)]);
}

/** `text` with every known secret value and every common secret format masked. */
export function redactText(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) redacted = redacted.split(value).join(MASK);
  for (const format of SECRET_FORMATS) redacted = redacted.replace(format, MASK);
  return redacted;
}

/**
 * A transcript fit to leave the session: secrets masked in every string, and the output of any tool call that touched
 * a secret file replaced by the fact that it did.
 */
export function redactTranscript(entries: readonly TranscriptEntry[], values: readonly string[]): TranscriptEntry[] {
  const withheld = new Set<string>();
  return entries.map((entry) => {
    if (!("notification" in entry)) return redact(entry, values);
    const update = entry.notification.update;
    if (update.sessionUpdate === "tool_call" && SECRET_FILE.test(JSON.stringify(update.rawInput ?? ""))) {
      withheld.add(update.toolCallId);
    }
    if (update.sessionUpdate === "tool_call_update" && withheld.has(update.toolCallId)) {
      const content = [{ type: "content" as const, content: { type: "text" as const, text: "[output of a secret file withheld]" } }];
      return redact({ ...entry, notification: { ...entry.notification, update: { ...update, content, rawOutput: undefined } } }, values);
    }
    return redact(entry, values);
  });
}

function redact<T>(value: T, values: readonly string[]): T {
  if (typeof value === "string") return redactText(value, values) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redact(item, values)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, values)])) as T;
  }
  return value;
}
