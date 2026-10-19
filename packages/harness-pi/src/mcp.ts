import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type McpTransport } from "@earendil-works/pi-mcp";
import { mcpToolName, type McpServer } from "@chopin-ai/core";
import type { Workspace } from "@chopin-ai/workspace";

type McpTool = Awaited<ReturnType<McpClient["listTools"]>>[number];

let version: Promise<string> | undefined;

/** This package's version, which MCP servers are told; "unknown" when the package cannot say. */
function packageVersion(): Promise<string> {
  version ??= readFile(new URL("../package.json", import.meta.url), "utf8")
    .then((text) => (JSON.parse(text) as { version?: string }).version ?? "unknown", () => "unknown");
  return version;
}

/**
 * One owner's MCP servers. A command server runs inside the owner's workspace, never on the service host: the
 * layer may change, and what it starts must stay as confined as the agent itself.
 */
export class McpServers {
  readonly #servers: Readonly<Record<string, McpServer>>;
  readonly #workspace: Workspace;
  readonly #clients = new Map<string, Promise<McpClient>>();
  #closed = false;
  /** Names of the offered tools that declare they change nothing. */
  readonly readOnly = new Set<string>();
  /** Servers that could not be reached when their tools were offered. */
  readonly unavailable = new Set<string>();

  constructor(servers: Readonly<Record<string, McpServer>>, workspace: Workspace) {
    this.#servers = servers;
    this.#workspace = workspace;
  }

  /** Connects every server and offers its tools, one extension per server; one that cannot be reached is left out. */
  connect(report: (error: Error) => void): Promise<Extension[]> {
    return this.#offer(Object.keys(this.#servers), report);
  }

  /**
   * Tries the unavailable servers again and offers the tools of those that answer now; a server in the workspace is
   * tried only while the workspace runs, so trying never wakes one stopped for being idle.
   */
  async retry(report: (error: Error) => void): Promise<Extension[]> {
    const inWorkspace = (server: string) => "command" in (this.#servers[server] as McpServer);
    const unavailable = [...this.unavailable];
    const running = unavailable.some(inWorkspace) && (await this.#workspace.state().catch(() => undefined)) === "running";
    return this.#offer(unavailable.filter((server) => running || !inWorkspace(server)), report, false);
  }

  /** Closes every client, and refuses to connect another, such as for a retry still under way. */
  async close(): Promise<void> {
    this.#closed = true;
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(clients.map(async (client) => (await client).close()));
  }

  async #offer(servers: readonly string[], report: (error: Error) => void, wake = true): Promise<Extension[]> {
    const offered = await Promise.all(servers.map(async (server) => {
      const client = this.#client(server, wake);
      try {
        const listed = await (await client).listTools();
        const unique = [...new Map(listed.map((tool) => [tool.name, tool])).values()];
        if (unique.length < listed.length) report(new Error(`MCP server ${server} lists a tool name twice; one of each is offered`));
        this.unavailable.delete(server);
        return [defineExtension({ name: `chopin-mcp-${server}`, tools: unique.map((tool) => this.#tool(server, tool)) })];
      } catch (error) {
        // A client that connected but cannot list its tools is let go, so the next try starts afresh.
        this.#drop(server, client);
        if (this.#closed) return [];
        if (!this.unavailable.has(server)) report(new Error(`MCP server ${server} is unavailable: ${(error as Error).message}`));
        this.unavailable.add(server);
        return [];
      }
    }));
    return this.#closed ? [] : offered.flat();
  }

  #client(server: string, wake = true): Promise<McpClient> {
    if (this.#closed) return Promise.reject(new Error("the MCP servers were closed"));
    let client = this.#clients.get(server);
    if (client === undefined) {
      client = this.#connect(server, wake);
      this.#clients.set(server, client);
      const forget = () => {
        if (this.#clients.get(server) === client) this.#clients.delete(server);
      };
      client.then((connected) => connected.onClose(forget), forget);
    }
    return client;
  }

  #drop(server: string, client: Promise<McpClient>): void {
    if (this.#clients.get(server) === client) this.#clients.delete(server);
    void client.then((connected) => connected.close()).catch(() => {});
  }

  async #connect(server: string, wake: boolean): Promise<McpClient> {
    // A server that never answers must not hold its owner's agent back for good.
    const client = new McpClient({ name: "chopin-ai", version: await packageVersion(), requestTimeoutMs: 30_000 });
    await client.connect(await this.#transport(this.#servers[server] as McpServer, wake));
    return client;
  }

  async #transport(server: McpServer, wake: boolean): Promise<McpTransport> {
    if (!("command" in server)) return new StreamableHttpTransport({ url: server.url, ...(server.headers && { headers: server.headers }) });
    if (wake) await this.#workspace.start();
    const { argv: [command, ...args], env } = this.#workspace.command([server.command, ...(server.args ?? [])], server.env);
    return new StdioTransport({ command: command as string, args, env });
  }

  #tool(server: string, tool: McpTool): ToolRegistration {
    const name = mcpToolName(server, tool.name);
    if (tool.annotations?.readOnlyHint === true) this.readOnly.add(name);
    return {
      name,
      description: tool.description ?? tool.name,
      parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
      execute: async (args, _api, context) => {
        const client = await this.#client(server);
        const signal = context.abortSignal;
        const result = await client.callTool(tool.name, args as Record<string, unknown>, signal === undefined ? {} : { signal });
        return { output: toLlmContent(result), isError: result.isError === true };
      },
    };
  }
}
