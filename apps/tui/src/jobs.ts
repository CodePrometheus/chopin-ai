import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CommandRefusal, isJobRequest, JobIdSchema, JobOutputSchema, JobSnapshotSchema, type CommandBroker, type JobOutput, type JobRequest, type JobSnapshot } from "@chopin-ai/harness-pi";
import { HostRefusal, HostTransport, HostTransportConfigurationSchema } from "./host-transport.js";

export const JobsConfigurationSchema = Type.Object({
  ...HostTransportConfigurationSchema.properties, scopeId: JobIdSchema,
}, { additionalProperties: false });
export type JobsConfiguration = Static<typeof JobsConfigurationSchema>;

/** Purpose-bound command client; it neither retries requests nor interprets missing observation as completion. */
export class JobClient implements CommandBroker {
  readonly #scope: string;
  readonly #transport: HostTransport;

  static async connect(configuration: JobsConfiguration, credential: string): Promise<JobClient> {
    const config = structuredClone(configuration);
    if (!Value.Check(JobsConfigurationSchema, config)) throw new Error("the command binding does not satisfy its declared contract");
    return new JobClient(config.scopeId, await HostTransport.connect(config, credential));
  }

  private constructor(scope: string, transport: HostTransport) { this.#scope = scope.toLowerCase(); this.#transport = transport; }

  submit(operation: string, request: JobRequest, signal?: AbortSignal): Promise<JobSnapshot> {
    return this.#intent("PUT", operation, "", request, signal);
  }
  cancel(operation: string, request: JobRequest, signal?: AbortSignal): Promise<JobSnapshot> {
    return this.#intent("POST", operation, "/cancel", request, signal);
  }
  async get(operation: string, signal?: AbortSignal): Promise<JobSnapshot | undefined> {
    try { return await this.#snapshot("GET", operation, "", undefined, signal); }
    catch (error) { if (error instanceof CommandRefusal && error.status === 404) return undefined; throw error; }
  }
  reconcile(operation: string, signal?: AbortSignal): Promise<JobSnapshot> { return this.#snapshot("POST", operation, "/reconcile", undefined, signal); }
  stop(operation: string, signal?: AbortSignal): Promise<JobSnapshot> { return this.#snapshot("DELETE", operation, "", undefined, signal); }

  async output(operation: string, limit: number, cursor?: string, signal?: AbortSignal): Promise<JobOutput> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("the output page size must be an explicit positive byte count");
    const query = new URLSearchParams({ limit: String(limit), ...(cursor !== undefined && { cursor }) });
    const page = await this.#json("GET", `${this.#operation(operation)}/output?${query}`, JobOutputSchema, undefined, signal);
    if (Buffer.from(page.data, "base64url").toString("base64url") !== page.data || (page.stream === null) !== (page.data === "")) throw new Error("the command output page has invalid byte encoding");
    return page;
  }

  async close(): Promise<void> { await this.#transport.close(); }

  async #intent(method: "PUT" | "POST", operation: string, suffix: string, request: JobRequest, signal?: AbortSignal): Promise<JobSnapshot> {
    const intent = structuredClone(request);
    if (!isJobRequest(intent)) throw new Error("the command intent does not satisfy its declared contract");
    return this.#snapshot(method, operation, suffix, intent, signal);
  }
  async #snapshot(method: "GET" | "POST" | "PUT" | "DELETE", operation: string, suffix: string, body?: object, signal?: AbortSignal): Promise<JobSnapshot> {
    const path = this.#operation(operation);
    const snapshot = await this.#json(method, `${path}${suffix}`, JobSnapshotSchema, body, signal);
    if (snapshot.scopeId.toLowerCase() !== this.#scope || snapshot.operationId.toLowerCase() !== path) throw new Error("the command host returned another operation's snapshot");
    return snapshot;
  }
  #operation(operation: string): string {
    if (!Value.Check(JobIdSchema, operation)) throw new Error("the command operation must be a canonical UUID");
    return operation.toLowerCase();
  }
  async #json<T extends TSchema>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, schema: T, body?: object, signal?: AbortSignal): Promise<Static<T>> {
    const response = await this.#transport.request(method, path, body, signal).catch((error: unknown) => {
      if (error instanceof HostRefusal) throw new CommandRefusal(error.status);
      throw error;
    });
    const value: unknown = await response.json().catch(() => { throw new Error("the command host returned an unreadable response"); });
    if (!Value.Check(schema, value)) throw new Error("the command response does not satisfy its declared contract");
    return value;
  }
}
