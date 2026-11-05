import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  McpAuthRequiredError, McpClient, McpConnectionClosedError, McpError, McpHttpError, McpTimeoutError, StdioTransport, StreamableHttpTransport, toLlmContent,
  type McpTransport,
} from "@earendil-works/pi-mcp";
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

/** A command server the workspace will not run, as one that runs only its execution daemon will not. */
class Refused extends Error {}

/** What kind of failure reaching an MCP server met, in words of this module's own. */
function failureKind(error: unknown): string {
  if (error instanceof McpAuthRequiredError || (error instanceof McpHttpError && (error.status === 401 || error.status === 403))) return "refused its credentials";
  if (error instanceof McpHttpError) return `answered HTTP ${error.status}`;
  if (error instanceof McpError) return "broke the protocol";
  if (error instanceof McpTimeoutError) return "did not answer in time";
  // A request that never got through: the connection closed, the fetch failed, or the system refused, as for a command not found.
  if (error instanceof McpConnectionClosedError || error instanceof TypeError || (error instanceof Error && "code" in error)) return "could not be reached";
  return "failed";
}

/** The extension a server's tools come in. */
export function mcpExtensionName(server: string): string {
  return `chopin-mcp-${server}`;
}

/**
 * One owner's MCP servers. A command server runs inside the owner's workspace, never on the service host: the
 * layer may change, and what it starts must stay as confined as the agent itself.
 */
export class McpServers {
  #servers: Readonly<Record<string, McpServer>>;
  readonly #workspace: Workspace;
  readonly #clients = new Map<string, Promise<McpClient>>();
  /** The tools each server offered when last reached. */
  readonly #tools = new Map<string, string[]>();
  /** Why each server that could not be reached last was not. */
  readonly #failures = new Map<string, string>();
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
   * Serves `server` under `name` from now on, in place of any by that name, and offers its tools; none while it
   * cannot be reached, which a retry tries again. Its tools name the server, so a replaced one's names are reused.
   */
  set(name: string, server: McpServer, report: (error: Error) => void): Promise<Extension[]> {
    this.#forget(name);
    this.#servers = { ...this.#servers, [name]: server };
    return this.#offer([name], report);
  }

  /** Stops serving `name`, answering with the names of the tools it offered. */
  remove(name: string): string[] {
    const tools = this.#forget(name);
    const { [name]: _gone, ...rest } = this.#servers;
    this.#servers = rest;
    return tools;
  }

  /** How many tools `name` offers, or why it offers none while it cannot be reached. */
  status(name: string): { tools: number; error?: string } {
    const error = this.#failures.get(name);
    return { tools: this.#tools.get(name)?.length ?? 0, ...(error !== undefined && { error }) };
  }

  /** Lets go of everything known of `name`: its client, its tools and why it failed; answers with those tools. */
  #forget(name: string): string[] {
    const client = this.#clients.get(name);
    if (client !== undefined) this.#drop(name, client);
    const tools = this.#tools.get(name) ?? [];
    for (const tool of tools) this.readOnly.delete(tool);
    this.#tools.delete(name);
    this.#failures.delete(name);
    this.unavailable.delete(name);
    return tools;
  }

  /**
   * Tries the unavailable servers again and offers the tools of those that answer now; a server in the workspace is
   * tried only while the workspace runs, so trying never wakes one stopped for being idle.
   */
  async retry(report: (error: Error) => void): Promise<Extension[]> {
    const inWorkspace = (server: string) => {
      const known = this.#servers[server];
      return known !== undefined && "command" in known;
    };
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
      // A server replaced or taken away while it was being reached is not offered: its successor is, by whoever set it.
      const serving = this.#servers[server];
      if (serving === undefined) return [];
      const client = this.#client(server, wake);
      const current = () => this.#servers[server] === serving;
      try {
        const listed = await (await client).listTools();
        if (!current()) {
          this.#drop(server, client);
          return [];
        }
        const unique = [...new Map(listed.map((tool) => [tool.name, tool])).values()];
        if (unique.length < listed.length) report(new Error(`MCP server ${server} lists a tool name twice; one of each is offered`));
        this.unavailable.delete(server);
        this.#failures.delete(server);
        const tools = unique.map((tool) => this.#tool(server, tool));
        this.#tools.set(server, tools.map((tool) => tool.name));
        return [defineExtension({ name: mcpExtensionName(server), tools })];
      } catch (error) {
        // A client that connected but cannot list its tools is let go, so the next try starts afresh.
        this.#drop(server, client);
        if (this.#closed || !current()) return [];
        // The owner sees the server's own words; a log names only the kind of failure, as those words may quote what
        // the server sent back, a credential among it.
        this.#failures.set(server, (error as Error).message);
        // A workspace that cannot run the server never will, so it is told once and not tried again.
        if (error instanceof Refused) {
          report(new Error(`MCP server ${server} cannot run here`));
          return [];
        }
        if (!this.unavailable.has(server)) report(new Error(`MCP server ${server} is unavailable: it ${failureKind(error)}`));
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
    let launch: ReturnType<Workspace["command"]>;
    try {
      launch = this.#workspace.command([server.command, ...(server.args ?? [])], server.env);
    } catch (error) {
      throw new Refused((error as Error).message, { cause: error });
    }
    if (wake) await this.#workspace.start();
    const { argv: [command, ...args], env } = launch;
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
