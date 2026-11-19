import type { Response } from "undici";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { GoalAuthorization, RecoveryAnchorStore } from "@chopin-ai/harness-pi";
import type { Wake } from "@earendil-works/pi-durable";
import type { InitializationAuthority } from "./initialize.js";
import { HostRefusal, HostTransport, HostTransportConfigurationSchema } from "./host-transport.js";

const integer = (minimum: number) => Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const ControlConfigurationSchema = object({
  ...HostTransportConfigurationSchema.properties,
  agentId: Type.String({ minLength: 1 }), epoch: integer(1), owner: Type.String({ minLength: 1 }),
});
export type ControlConfiguration = Static<typeof ControlConfigurationSchema>;

const head = object({ sequence: integer(0), digest: Type.String({ minLength: 1 }) });
const pending = object({ operationId: Type.String({ minLength: 1 }), generation: integer(1), next: head });
const anchor = object({ head, pending: Type.Union([pending, Type.Null()]) });
const decision = object({ allowed: Type.Boolean(), reason: Type.Optional(Type.String()) });
const lease = object({ operationId: Type.String({ minLength: 1 }), serviceKey: Type.String({ minLength: 1 }) });
const runtimeKey = object({ revision: integer(1), serviceKey: Type.String({ minLength: 1 }) });
const receipt = object({ operationId: Type.String({ minLength: 1 }), revision: integer(1), action: Type.Literal("enrolled"), createdAt: Type.String({ minLength: 1 }) });
const wakeState = object({ active: Type.Boolean(), at: Type.Optional(integer(-Number.MAX_SAFE_INTEGER)) });

/** A fixed trusted binding and private transport, independent of model or plugin proxies. */
export class ControlHost {
  readonly #identity: { agentId: string; epoch: number; owner: string };
  readonly #transport: HostTransport;

  static async connect(configuration: ControlConfiguration, credential: string): Promise<ControlHost> {
    const config = structuredClone(configuration);
    if (!Value.Check(ControlConfigurationSchema, config)) throw new Error("the control binding does not satisfy its versioned contract");
    return new ControlHost(config, await HostTransport.connect(config, credential));
  }

  private constructor(configuration: ControlConfiguration, transport: HostTransport) {
    this.#identity = { agentId: configuration.agentId, epoch: configuration.epoch, owner: configuration.owner };
    this.#transport = transport;
  }

  anchors(): RecoveryAnchorStore {
    return {
      generation: this.#identity.epoch,
      read: () => this.#post("anchor/read", {}, anchor, true),
      init: (head) => this.#required("anchor/init", { head }, anchor),
      prepare: (expected, pending) => this.#required("anchor/prepare", { expected, pending }, anchor),
      confirm: (pending, local) => this.#required("anchor/confirm", { pending, local }, anchor),
      abort: (pending, verifiedLocal) => this.#required("anchor/abort", { pending, verifiedLocal }, anchor),
    };
  }

  authorize(request: GoalAuthorization, signal?: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
    const { action, grant, tool } = request;
    return this.#required("authority", { action, ...(grant !== undefined && { grant }), ...(tool !== undefined && { tool }) }, decision, signal);
  }

  /** Releases only the current admitted execution writer's key over the private host transport. */
  async executionKey(signal?: AbortSignal): Promise<{ revision: number; key: Buffer }> {
    const received = await this.#required("execution/key", {}, runtimeKey, signal);
    const key = Buffer.from(received.serviceKey, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== received.serviceKey) {
      key.fill(0);
      throw new Error("the host returned an invalid execution key lease");
    }
    return { revision: received.revision, key };
  }

  async publishWake(wake: Wake): Promise<void> {
    if (!Value.Check(wakeState, wake)) throw new Error("the wake projection does not satisfy its declared contract");
    const response = await this.#request("wake", { wake });
    if (response?.status !== 204) {
      await response?.body?.cancel();
      throw new Error("the control host did not acknowledge the wake projection");
    }
  }

  initialization(operationId: string): InitializationAuthority {
    return {
      verifyCreation: async () => {
        if (!(await this.#required("initialization/verify", { operationId }, decision)).allowed) throw new Error("the host has not admitted this initialization");
      },
      key: async () => {
        const received = await this.#required("initialization/key", { operationId }, lease);
        const key = Buffer.from(received.serviceKey, "base64url");
        if (received.operationId !== operationId || key.length !== 32 || key.toString("base64url") !== received.serviceKey) {
          key.fill(0);
          throw new Error("the host returned an invalid initialization key lease");
        }
        return { operationId: received.operationId, key };
      },
      complete: (head) => this.#required("initialization/complete", { operationId, head }, receipt),
    };
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }

  async #required<T extends TSchema>(path: string, body: object, schema: T, signal?: AbortSignal): Promise<Static<T>> {
    const result = await this.#post(path, body, schema, false, signal);
    if (result === undefined) throw new Error("the control host omitted a required response");
    return result;
  }

  async #post<T extends TSchema>(path: string, body: object, schema: T, missing = false, signal?: AbortSignal): Promise<Static<T> | undefined> {
    const response = await this.#request(path, body, missing, signal);
    if (response === undefined) return undefined;
    const value: unknown = await response.json().catch(() => { throw new Error("the control host returned an unreadable response"); });
    if (!Value.Check(schema, value)) throw new Error("the control response does not satisfy its declared contract");
    return value;
  }

  async #request(path: string, body: object, missing = false, signal?: AbortSignal): Promise<Response | undefined> {
    try {
      return await this.#transport.request("POST", `internal/v1/${path}`, { ...this.#identity, ...body }, signal);
    } catch (error) {
      if (missing && error instanceof HostRefusal && error.status === 404) return undefined;
      throw error;
    }
  }
}
