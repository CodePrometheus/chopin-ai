import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch, type Response } from "undici";

const EXECUTABLE = "/opt/qwen-code/bin/qwen";
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
const AUTHORIZATION_ORIGIN = "https://chat.qwen.ai";
const FLOW_PATH = "auth/subscription/flows";

export interface QwenSubscriptionAccount {
  status: "signed_in" | "signed_out" | "unknown";
  accountLabel: string | null;
  entitlement: "eligible" | "ineligible" | "unknown";
  plan?: string;
}

export interface QwenSubscriptionFlow {
  id: string;
  status: "waiting" | "authorized" | "failed" | "expired" | "unknown";
  /** Private authorization URL, delivered only over the authenticated host transport. */
  authorizationUrl?: string;
  account?: QwenSubscriptionAccount;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function failure(): Error {
  return new Error("the official subscription daemon could not complete the account operation");
}

function flowPath(id: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw failure();
  return FLOW_PATH + "/" + id;
}

function accountOf(value: unknown): QwenSubscriptionAccount {
  if (value === null) return { status: "unknown", accountLabel: null, entitlement: "unknown" };
  const info = record(value);
  const membership = typeof info.member_type === "string" ? info.member_type.trim().toLowerCase() : "";
  const accountLabel = typeof info.name === "string" && info.name !== "" ? info.name
    : typeof info.email === "string" ? info.email : null;
  return {
    status: "signed_in",
    accountLabel,
    ...(membership !== "" && { plan: membership }),
    entitlement: membership === "" ? "unknown" : membership === "plus" || membership === "pro" ? "eligible" : "ineligible",
  };
}

function authorization(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (url === null || url.origin !== AUTHORIZATION_ORIGIN || url.pathname !== "/authorize" ||
      url.username || url.password || url.hash || !url.searchParams.get("user_code") ||
      url.searchParams.get("entry") !== "qwen_code" ||
      url.searchParams.get("client") !== "cli" || url.searchParams.get("paywallScene") !== "cli") throw failure();
  return url.href;
}

function flow(value: unknown, expectedId?: string): QwenSubscriptionFlow {
  const data = record(value);
  const id = data.id;
  if (typeof id !== "string" || expectedId !== undefined && id !== expectedId) throw failure();
  flowPath(id);
  switch (data.status) {
    case "waiting": {
      const authorizationUrl = authorization(data.authorizationUrl);
      return { id, status: "waiting", ...(authorizationUrl === undefined ? {} : { authorizationUrl }) };
    }
    case "ready": return { id, status: "authorized", account: accountOf(data.userInfo ?? null) };
    case "error": return { id, status: data.errorCode === "expired_token" ? "expired" : "failed" };
    default: throw failure();
  }
}

/**
 * Narrow client for one original subscription daemon. Its bearer and profile belong to one
 * protected owner. For switching accounts, the host provides a separate candidate daemon.
 */
export class QwenSubscriptionClient {
  readonly #base: URL;
  readonly #bearer: string;
  readonly #timeoutMs: number;
  readonly #dispatcher = new Agent();

  constructor(origin: string, bearer: string, timeoutMs: number) {
    const base = URL.parse(origin);
    if (base === null || base.protocol !== "http:" || !LOOPBACK.has(base.hostname) ||
        base.href !== base.origin + "/" || !/^[\x21-\x7e]+$/.test(bearer) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fff_ffff) throw failure();
    this.#base = base;
    this.#bearer = bearer;
    this.#timeoutMs = timeoutMs;
  }

  /** Reads the official signed-in state and separates actual subscription membership. */
  async account(): Promise<QwenSubscriptionAccount> {
    const capability = record(await this.#json("GET", "auth/subscription"));
    if (capability.enabled !== true || typeof capability.signedIn !== "boolean") throw failure();
    if (!capability.signedIn) return { status: "signed_out", accountLabel: null, entitlement: "unknown" };
    return accountOf(await this.#json("POST", "auth/subscription/userinfo"));
  }

  /** Begins the official browser device flow once. */
  async startLogin(): Promise<QwenSubscriptionFlow> {
    return flow(await this.#json("POST", FLOW_PATH + "?paywallScene=cli", 201));
  }

  /** Reads the same native flow. An absent or retired flow stays unknown. */
  async loginStatus(id: string): Promise<QwenSubscriptionFlow> {
    const response = await this.#request("GET", flowPath(id));
    if (response.status === 404) {
      await response.body?.cancel();
      return { id, status: "unknown" };
    }
    return flow(await this.#readJson(response, 200), id);
  }

  /** Cancels the native flow. The owner supervisor retires an abandoned candidate. */
  async cancelLogin(id: string): Promise<void> {
    await this.#empty("DELETE", flowPath(id));
  }

  /** Activates the independently verified workspace using the signed-in subscription. */
  async activate(workspace: string): Promise<void> {
    if (workspace.trim() === "") throw failure();
    const result = record(await this.#json("POST", "workspaces/" + encodeURIComponent(workspace) + "/auth/subscription", 200, { settingsScope: "user" }));
    if (result.authType !== "qwen-subscription" || typeof result.modelId !== "string" ||
        result.modelId === "" || record(result.runtimeSync).status !== "applied") throw failure();
  }

  /** Revokes the active account. A missing response is reconciled from the account state. */
  async logout(): Promise<void> {
    await this.#empty("POST", "auth/subscription/revoke");
    if ((await this.account()).status !== "signed_out") throw failure();
  }

  /** Closes the private transport. The owner supervisor owns the daemon process. */
  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  async #request(method: string, route: string, value?: object): Promise<Response> {
    try {
      return await fetch(new URL(route, this.#base), {
        method,
        dispatcher: this.#dispatcher,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: "Bearer " + this.#bearer,
          ...(value === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    } catch { throw failure(); }
  }

  async #readJson(response: Response, status: number): Promise<unknown> {
    if (response.status !== status) {
      await response.body?.cancel();
      throw failure();
    }
    try { return await response.json(); }
    catch { throw failure(); }
  }

  async #json(method: string, route: string, status = 200, value?: object): Promise<unknown> {
    return this.#readJson(await this.#request(method, route, value), status);
  }

  async #empty(method: string, route: string): Promise<void> {
    const response = await this.#request(method, route);
    await response.body?.cancel();
    if (response.status !== 204) throw failure();
  }
}

/** Runs only the official account routes. Model dispatch and workspace tools are not exposed here. */
export async function openQwenSubscription(profile: string, timeoutMs: number): Promise<{
  client: QwenSubscriptionClient;
  activate(): Promise<void>;
  close(): Promise<void>;
}> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const directory = await lstat(profile);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw failure();
  const runtime = await mkdtemp(join(tmpdir(), "chopin-qwen-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const workspace = await realpath(runtime);
    const settings = join(runtime, "managed-settings.json");
    await writeFile(settings, JSON.stringify({
      security: { auth: { enforcedType: "qwen-subscription" } },
      disableAllHooks: true,
      privacy: { usageStatisticsEnabled: false },
      ui: { enableFollowupSuggestions: false },
    }), { mode: 0o600 });
    const bearer = randomBytes(32).toString("base64url");
    const child = spawn(EXECUTABLE, [
      "serve", "--hostname", "127.0.0.1", "--port", "0", "--workspace", workspace,
      "--no-web", "--no-token-qr", "--require-auth",
    ], {
      cwd: workspace,
      env: {
        PATH: "/usr/bin:/bin", HOME: workspace,
        QWEN_HOME: profile, QWEN_RUNTIME_DIR: join(runtime, "runtime"),
        QWEN_SERVER_TOKEN: bearer, QWEN_CODE_SYSTEM_SETTINGS_PATH: settings,
        QWEN_CODE_MODELS_DEV_REFRESH: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    const ready = Promise.withResolvers<string>();
    const exited = new Promise<void>((resolve) => child.once("close", () => {
      ready.reject(failure());
      resolve();
    }));
    child.on("error", () => ready.reject(failure()));
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      const address = /^qwen serve listening on (http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}) \(/.exec(line)?.[1];
      if (address !== undefined) ready.resolve(address);
    });
    stop = async () => {
      child.kill("SIGTERM");
      const deadline = new AbortController();
      try {
        if (!await Promise.race([exited.then(() => true), delay(1500, false, { signal: deadline.signal, ref: false })])) {
          child.kill("SIGKILL");
          await exited;
        }
      } finally {
        deadline.abort();
      }
    };
    const deadline = setTimeout(() => ready.reject(failure()), timeoutMs);
    let address: string;
    try { address = await ready.promise; } finally { clearTimeout(deadline); }
    const client = new QwenSubscriptionClient(address, bearer, timeoutMs);
    return {
      client,
      activate: () => client.activate(workspace),
      close: async () => {
        await stop!();
        await client.close();
        await rm(runtime, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop?.();
    await rm(runtime, { recursive: true, force: true });
    throw error;
  }
}
