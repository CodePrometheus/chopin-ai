import { readFile } from "node:fs/promises";
import { Agent, fetch, type Response } from "undici";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const HostTransportConfigurationSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  // Node timers clamp delays above the signed 32-bit range to one millisecond.
  requestTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 0x7fff_ffff })),
  maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  caFile: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
export type HostTransportConfiguration = Static<typeof HostTransportConfigurationSchema>;

/** An authoritative HTTP refusal; a transport failure leaves the operation outcome unknown. */
export class HostRefusal extends Error {
  readonly status: number;
  constructor(status: number) { super(`the trusted host refused the operation: ${status}`); this.status = status; }
}

/** Private authenticated transport, independent of model and plugin proxy configuration. */
export class HostTransport {
  readonly #base: URL;
  readonly #credential: string;
  readonly #timeout: number | undefined;
  readonly #agent: Agent;
  #closed = false;
  #closing: Promise<void> | undefined;

  static async connect(configuration: HostTransportConfiguration, credential: string): Promise<HostTransport> {
    const { url, requestTimeoutMs, maxResponseBytes, caFile } = configuration;
    const config = { url, ...(requestTimeoutMs !== undefined && { requestTimeoutMs }), ...(maxResponseBytes !== undefined && { maxResponseBytes }), ...(caFile !== undefined && { caFile }) };
    if (!Value.Check(HostTransportConfigurationSchema, config)) throw new Error("the trusted host transport configuration is invalid");
    const ca = config.caFile === undefined ? undefined : await readFile(config.caFile);
    return new HostTransport(config, credential, ca);
  }

  private constructor(configuration: HostTransportConfiguration, credential: string, ca?: Buffer) {
    const base = new URL(configuration.url);
    if (!["http:", "https:"].includes(base.protocol) || base.username !== "" || base.password !== "" || base.hash !== "" || base.search !== "") throw new Error("the trusted host endpoint must be a credential-free HTTP address");
    if (credential === "" || /[^\x21-\x7e]/.test(credential)) throw new Error("the trusted host credential is invalid");
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.#base = base;
    this.#credential = credential;
    this.#timeout = configuration.requestTimeoutMs;
    this.#agent = new Agent({
      ...(configuration.maxResponseBytes !== undefined && { maxResponseSize: configuration.maxResponseBytes }),
      connect: { rejectUnauthorized: true, ...(ca !== undefined && { ca }) },
    });
  }

  get secure(): boolean { return this.#base.protocol === "https:"; }

  async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object, signal?: AbortSignal): Promise<Response> {
    if (this.#closed) throw new Error("the trusted host transport is closed");
    const url = new URL(path, this.#base);
    if (url.origin !== this.#base.origin || !url.pathname.startsWith(this.#base.pathname)) throw new Error("the trusted host route escaped its configured mount");
    const deadline = this.#timeout === undefined ? undefined : AbortSignal.timeout(this.#timeout);
    const abort = signal === undefined ? deadline : deadline === undefined ? signal : AbortSignal.any([signal, deadline]);
    const response = await fetch(url, {
      method, redirect: "error", dispatcher: this.#agent,
      headers: { authorization: `Bearer ${this.#credential}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(abort !== undefined && { signal: abort }),
    }).catch((cause: unknown) => { throw new Error("the trusted host operation outcome could not be observed", { cause }); });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HostRefusal(response.status);
    }
    return response;
  }

  close(): Promise<void> { this.#closed = true; return this.#closing ??= this.#agent.close(); }
}
