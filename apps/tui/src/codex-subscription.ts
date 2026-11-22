import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const EXECUTABLE = "/usr/local/bin/codex";
const VERIFICATION = "https://auth.openai.com/codex/device";

export type CodexAccount =
  | { status: "signed_out" | "unknown" }
  | { status: "signed_in"; accountLabel: string | null; plan?: string };

export type CodexLoginState = "waiting" | "authorized" | "cancelled" | "failed" | "expired" | "unknown";

export interface CodexLoginChallenge {
  /** Private identifier scoped to this App Server instance. */
  loginId: string;
  /** The pinned client's first-party device authorization page. */
  verificationUrl: string;
  /** Short code shown to the user and entered on the first-party page. */
  displayCode: string;
}

interface Completion {
  id: string;
  status: "authorized" | "failed" | "expired";
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function failure(): Error {
  return new Error("the official subscription client could not complete the account operation");
}

/**
 * Account operations on one original client profile. The host chooses an isolated candidate
 * directory for a new sign-in and publishes it only after confirming and protecting that profile.
 */
export class CodexSubscriptionClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<void>;
  #next = 1;
  #closed = false;
  #starting = false;
  #started = false;
  #closing: Promise<void> | undefined;
  #loginId: string | undefined;
  #completion: Completion | undefined;
  #cancelled = false;

  /** Opens the packaged official client with its own private credentials and no inherited token. */
  static async open(profile: string, timeoutMs: number): Promise<CodexSubscriptionClient> {
    if (!isAbsolute(profile) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fff_ffff) {
      throw failure();
    }
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const directory = await lstat(profile);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw failure();
    const client = new CodexSubscriptionClient(profile, timeoutMs);
    try {
      await client.#call("initialize", {
        clientInfo: { name: "managed_workspace", title: "Managed workspace", version: "1" },
      });
      await client.#send({ method: "initialized" });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private constructor(profile: string, timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    this.#child = spawn(EXECUTABLE, [
      "-c", 'cli_auth_credentials_store="file"',
      "-c", 'forced_login_method="chatgpt"',
      "app-server", "--listen", "stdio://",
    ], { cwd: profile, env: { CODEX_HOME: profile }, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.resume();
    this.#child.stdin.on("error", () => this.#disconnect());
    this.#child.on("error", () => this.#disconnect());
    this.#exited = new Promise<void>((resolve) => this.#child.once("close", () => {
      this.#disconnect();
      resolve();
    }));
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on("line", (line) => this.#receive(line));
  }

  /** Reads the provider's current account without prompting or inferring model entitlement. */
  async account(): Promise<CodexAccount> {
    const view = record(await this.#call("account/read", { refreshToken: false }));
    if (view.account === null) return { status: "signed_out" };
    const account = record(view.account);
    if (account.type !== "chatgpt") return { status: "unknown" };
    return {
      status: "signed_in",
      accountLabel: typeof account.email === "string" ? account.email : null,
      ...(typeof account.planType === "string" ? { plan: account.planType } : {}),
    };
  }

  /** Starts one remote device sign-in. Recovery must read the original attempt rather than restart it. */
  async startLogin(): Promise<CodexLoginChallenge> {
    if (this.#started) throw failure();
    this.#started = true;
    this.#starting = true;
    try {
      const started = record(await this.#call("account/login/start", { type: "chatgptDeviceCode" }));
      if (started.type !== "chatgptDeviceCode" || started.verificationUrl !== VERIFICATION ||
          typeof started.loginId !== "string" || started.loginId === "" ||
          typeof started.userCode !== "string" || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(started.userCode)) {
        throw failure();
      }
      this.#loginId = started.loginId;
      return { loginId: started.loginId, verificationUrl: VERIFICATION, displayCode: started.userCode };
    } finally {
      this.#starting = false;
    }
  }

  /** Reports the original native attempt. A disconnect gives an unknown state. */
  loginStatus(loginId: string): CodexLoginState {
    if (loginId !== this.#loginId) return "unknown";
    if (this.#cancelled) return "cancelled";
    if (this.#completion?.id === loginId) return this.#completion.status;
    return this.#closed ? "unknown" : "waiting";
  }

  /** Cancels the original native attempt and refuses to treat an absent attempt as cancelled. */
  async cancelLogin(loginId: string): Promise<boolean> {
    if (loginId !== this.#loginId) return false;
    if (this.#cancelled) return true;
    const result = record(await this.#call("account/login/cancel", { loginId }));
    if (result.status !== "canceled") return false;
    this.#cancelled = true;
    return true;
  }

  /** Logs out the official client's active profile. The caller then protects that result. */
  async logout(): Promise<void> {
    await this.#call("account/logout", undefined);
    if ((await this.account()).status !== "signed_out") throw failure();
  }

  /** Closes exactly this official client. */
  close(): Promise<void> {
    return this.#closing ??= this.#close();
  }

  async #close(): Promise<void> {
    this.#disconnect();
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    if (await this.#waitForExit()) return;
    this.#child.kill("SIGKILL");
    if (!await this.#waitForExit()) throw failure();
  }

  async #waitForExit(): Promise<boolean> {
    const cancel = new AbortController();
    try {
      return await Promise.race([
        this.#exited.then(() => true),
        delay(this.#timeoutMs, false, { ref: false, signal: cancel.signal }),
      ]);
    } finally {
      cancel.abort();
    }
  }

  #disconnect(): void {
    this.#closed = true;
    for (const request of this.#pending.values()) {
      clearTimeout(request.timeout);
      request.reject(failure());
    }
    this.#pending.clear();
  }

  #send(value: object): Promise<void> {
    if (this.#closed) return Promise.reject(failure());
    return new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(JSON.stringify(value) + "\n", (error) => error ? reject(failure()) : resolve());
    });
  }

  #call(method: string, params: object | undefined): Promise<unknown> {
    if (this.#closed) return Promise.reject(failure());
    const id = this.#next++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure());
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      void this.#send({ id, method, params }).catch(() => this.#disconnect());
    });
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line) as unknown); }
    catch { this.#disconnect(); return; }
    if (message.method === "account/login/completed") {
      const value = record(message.params);
      if (typeof value.loginId !== "string" || typeof value.success !== "boolean" ||
          (!this.#starting && value.loginId !== this.#loginId)) return;
      this.#completion = {
        id: value.loginId,
        status: value.success ? "authorized" :
          typeof value.error === "string" && /\bexpired\b/i.test(value.error) ? "expired" : "failed",
      };
      return;
    }
    if (message.method !== undefined || typeof message.id !== "number") return;
    const request = this.#pending.get(message.id);
    if (request === undefined) return;
    clearTimeout(request.timeout);
    this.#pending.delete(message.id);
    if (message.error !== undefined) request.reject(failure());
    else request.resolve(message.result);
  }
}
