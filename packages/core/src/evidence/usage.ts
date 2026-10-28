import { isMcpToolOf } from "../layer/mcp.js";
import { chopinMeta } from "../meta.js";
import type { TranscriptEntry } from "../transcript.js";

/** How often a transcript used each part of the layer. */
export interface LayerUsage {
  /** Skill reads, by skill name. */
  skills: Map<string, number>;
  /** Tool calls, by MCP server. */
  mcpServers: Map<string, number>;
  /** Tool calls a hook refused, such as a gate. */
  blocked: number;
}

/** What `entries` used of a layer whose MCP servers are `servers`. */
export function layerUsage(entries: readonly TranscriptEntry[], servers: readonly string[]): LayerUsage {
  const used: LayerUsage = { skills: new Map(), mcpServers: new Map(), blocked: 0 };
  const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const entry of entries) {
    if (!("notification" in entry)) continue;
    const update = entry.notification.update;
    if (update.sessionUpdate === "tool_call") {
      const name = (update.rawInput as { name?: unknown } | undefined)?.name;
      if (update.title === "skill" && typeof name === "string") bump(used.skills, name);
      const server = servers.find((candidate) => isMcpToolOf(candidate, update.title));
      if (server !== undefined) bump(used.mcpServers, server);
    }
    if (update.sessionUpdate === "tool_call_update" && chopinMeta(update)?.diagnostics?.includes("blocked")) used.blocked += 1;
  }
  return used;
}
