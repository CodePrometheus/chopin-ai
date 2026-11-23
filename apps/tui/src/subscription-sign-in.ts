import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { subkey, unseal, writeSealed } from "@chopin-ai/harness-pi";
import type {
  SubscriptionProviderId, SubscriptionSignInAccount, SubscriptionSignInAttempt,
  SubscriptionSignInMode, SubscriptionSignInSnapshot,
} from "@chopin-ai/harness-pi/protocol";
import { openQwenSubscription } from "./qwen-subscription.js";

const QWEN = { id: "qwen", name: "Qwen Code" } as const;
const REQUEST_MS = 15_000;
const POLL_MS = 1_000;
const LOGIN_MS = 15 * 60_000;
const PROFILE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type Challenge = { verificationUrl: string; displayCode?: string };
type Account = Omit<SubscriptionSignInAccount, "provider">;
type Login = {
  status: "waiting" | "ready" | "failed" | "expired";
  challenge?: Challenge;
};
interface Client {
  account(): Promise<Account>;
  begin(): Promise<void>;
  poll(): Promise<Login>;
  activate(): Promise<void>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  close(): Promise<void>;
}
interface Active {
  id: string;
  client: Client;
  account: Account;
}
interface Attempt {
  view: SubscriptionSignInAttempt;
  client: Client | undefined;
  challenge: Challenge | undefined;
  timer?: NodeJS.Timeout;
  deadline: number;
}

function failure(): Error { return new Error("the official subscription operation could not be completed"); }

/** Manages the device login for one admitted owner, independently of any observing connection. */
export class SubscriptionSignInRuntime {
  readonly #active = new Map<SubscriptionProviderId, Active>();
  readonly #attempts = new Map<SubscriptionProviderId, Attempt>();
  readonly #unavailable = new Set<SubscriptionProviderId>();
  readonly #key: Buffer;
  readonly #home: string;
  readonly #volume: string;
  readonly #binding: string;
  readonly #providers: SubscriptionSignInSnapshot["providers"];
  readonly #persist: () => Promise<void>;
  readonly #authorize: () => Promise<boolean>;
  readonly #report: (error: Error) => void;
  #line: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    home: string,
    volume: string,
    key: Uint8Array,
    binding: string,
    providers: readonly "qwen"[],
    persist: () => Promise<void>,
    authorize: () => Promise<boolean>,
    report: (error: Error) => void,
  ) {
    this.#home = home;
    this.#volume = volume;
    this.#key = subkey(key, "subscription profiles");
    this.#binding = binding;
    this.#providers = providers.includes(QWEN.id) ? [QWEN] : [];
    this.#persist = persist;
    this.#authorize = authorize;
    this.#report = report;
  }

  snapshot(): Promise<SubscriptionSignInSnapshot> {
    return this.#run(async () => ({
      providers: this.#providers.map(({ id, name }) => ({ id, name })),
      attempts: [...this.#attempts.values()].map(({ view }) => ({ ...view })),
      accounts: await Promise.all(this.#providers.map(async ({ id: provider }): Promise<SubscriptionSignInAccount> => {
        const active = await this.#load(provider).catch(() => null);
        if (active === null) return { provider, status: "unknown" };
        if (active === undefined) return { provider, status: "signed_out" };
        const { account, id } = active;
        return { provider, ...account, ...(account.status === "signed_in" && { accountId: id }) };
      })),
    }));
  }

  #admits(provider: SubscriptionProviderId): boolean {
    return this.#providers.some(({ id }) => id === provider);
  }

  start(provider: SubscriptionProviderId, mode: SubscriptionSignInMode): Promise<string> {
    return this.#run(async () => {
      if (!this.#admits(provider)) throw failure();
      if (!await this.#authorize()) throw failure();
      const active = await this.#load(provider);
      const signedIn = active?.account.status === "signed_in";
      if (active?.account.status === "unknown" || signedIn !== (mode === "switch_account")) throw failure();
      const previous = this.#attempts.get(provider);
      if (previous?.view.status === "waiting") await this.#finish(previous, "cancelled");
      const id = randomUUID();
      const client = await openClient(this.#profile(provider, id));
      const attempt: Attempt = {
        view: { id, provider, mode, status: "waiting", challengeAvailable: false },
        client, challenge: undefined, deadline: Date.now() + LOGIN_MS,
      };
      this.#attempts.set(provider, attempt);
      try {
        await client.begin();
        this.#schedule(attempt);
        return id;
      } catch {
        await this.#finish(attempt, "failed");
        throw failure();
      }
    });
  }

  cancel(id: string): Promise<void> {
    return this.#run(async () => {
      if (!await this.#authorize()) throw failure();
      const attempt = this.#attempt(id);
      if (attempt.view.status === "cancelled") return;
      if (attempt.view.status !== "waiting") throw failure();
      await this.#finish(attempt, "cancelled");
    });
  }

  disconnect(provider: SubscriptionProviderId, expectedAccountId: string): Promise<boolean> {
    return this.#run(async () => {
      if (!this.#admits(provider)) return false;
      if (!await this.#authorize()) throw failure();
      const active = await this.#load(provider);
      // A delayed confirmation must not affect a subsequent login or its pending replacement.
      if (active?.account.status !== "signed_in" || active.id !== expectedAccountId) return false;
      const pending = this.#attempts.get(provider);
      if (pending?.view.status === "waiting") await this.#finish(pending, "cancelled");
      const upstreamFailed = await active.client.logout().then(() => false, () => true);
      active.account = await active.client.account().catch((): Account => ({ status: "unknown" }));
      if (active.account.status !== "signed_out") throw failure();
      await this.#publish(provider);
      this.#active.delete(provider);
      await this.#retire(provider, active);
      if (upstreamFailed) throw failure();
      return true;
    });
  }

  deliver(id: string, send: (challenge: Challenge) => Promise<void>): Promise<void> {
    return this.#run(async () => {
      if (!await this.#authorize()) throw failure();
      const attempt = this.#attempt(id);
      if (attempt.view.status !== "waiting" || attempt.challenge === undefined || Date.now() >= attempt.deadline) throw failure();
      await send(attempt.challenge);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#line;
    const tasks = [
      ...[...this.#attempts.values()].filter(({ view }) => view.status === "waiting").map((attempt) => this.#finish(attempt, "cancelled")),
      ...[...this.#active.values()].map(({ client }) => client.close()),
    ];
    const results = await Promise.allSettled(tasks);
    this.#key.fill(0);
    if (results.some(({ status }) => status === "rejected")) throw failure();
  }

  #run<T>(operate: () => Promise<T>): Promise<T> {
    const next = this.#line.then(() => {
      if (this.#closed) throw failure();
      return operate();
    });
    this.#line = next.catch(() => {});
    return next.catch(() => { throw failure(); });
  }

  #attempt(id: string): Attempt {
    const attempt = [...this.#attempts.values()].find(({ view }) => view.id === id);
    if (attempt === undefined || !this.#admits(attempt.view.provider)) throw failure();
    return attempt;
  }

  #profile(provider: SubscriptionProviderId, id: string): string { return join(this.#home, provider, id); }
  #pointer(provider: SubscriptionProviderId): string { return join(this.#volume, "subscription-" + provider); }
  #association(provider: SubscriptionProviderId): string { return JSON.stringify(["subscription profile", this.#binding, provider]); }

  async #load(provider: SubscriptionProviderId): Promise<Active | undefined> {
    if (!this.#admits(provider) || this.#unavailable.has(provider)) throw failure();
    const cached = this.#active.get(provider);
    if (cached !== undefined) return cached;
    const encoded = await readFile(this.#pointer(provider)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (encoded === undefined) return undefined;
    const id = unseal(this.#key, this.#association(provider), encoded).toString("utf8");
    if (id === "") return undefined;
    if (!PROFILE_ID.test(id)) throw failure();
    const client = await openClient(this.#profile(provider, id));
    try {
      const active = { id, client, account: await client.account() };
      this.#active.set(provider, active);
      return active;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #publish(provider: SubscriptionProviderId, id?: string): Promise<void> {
    try {
      // Commit the protected profile first. A restored candidate cannot become active until the pointer seals.
      await this.#persist();
      await writeSealed(this.#pointer(provider), this.#key, this.#association(provider), Buffer.from(id ?? ""));
    } catch (error) {
      this.#unavailable.add(provider);
      throw error;
    }
  }

  #schedule(attempt: Attempt): void {
    if (this.#closed) return;
    attempt.timer = setTimeout(() => {
      void this.#run(() => this.#poll(attempt)).catch(() => { if (!this.#closed) this.#report(failure()); });
    }, POLL_MS);
    attempt.timer.unref();
  }

  async #poll(attempt: Attempt): Promise<void> {
    const client = attempt.client;
    if (attempt.view.status !== "waiting" || client === undefined || !this.#admits(attempt.view.provider)) return;
    if (Date.now() >= attempt.deadline) { await this.#finish(attempt, "expired"); return; }
    try {
      const login = await client.poll();
      if (login.status === "waiting") {
        attempt.challenge = login.challenge;
        attempt.view = { ...attempt.view, challengeAvailable: login.challenge !== undefined };
        this.#schedule(attempt);
        return;
      }
      if (login.status !== "ready") { await this.#finish(attempt, login.status); return; }
      const { provider, id } = attempt.view;
      if (!await this.#authorize() || this.#closed) throw failure();
      const account = await client.account();
      if (account.status !== "signed_in") throw failure();
      await client.activate();
      if (!await this.#authorize() || this.#closed) throw failure();
      const previous = this.#active.get(provider);
      await this.#publish(provider, id);
      this.#active.set(provider, { id, client, account });
      attempt.client = undefined;
      await this.#finish(attempt, "authorized");
      if (previous !== undefined) await this.#retire(provider, previous);
    } catch {
      if (attempt.view.status === "waiting") await this.#finish(attempt, "failed");
      this.#report(failure());
    }
  }

  async #finish(attempt: Attempt, status: SubscriptionSignInAttempt["status"]): Promise<void> {
    clearTimeout(attempt.timer);
    attempt.challenge = undefined;
    attempt.view = { ...attempt.view, status, challengeAvailable: false };
    const client = attempt.client;
    attempt.client = undefined;
    if (client === undefined) return;
    await client.cancel().catch(() => {});
    await client.close();
    if (!this.#unavailable.has(attempt.view.provider)) {
      await rm(this.#profile(attempt.view.provider, attempt.view.id), { recursive: true, force: true });
    }
  }

  async #retire(provider: SubscriptionProviderId, active: Active): Promise<void> {
    await active.client.close();
    await rm(this.#profile(provider, active.id), { recursive: true, force: true });
  }
}

async function openClient(profile: string): Promise<Client> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const { client, activate, close } = await openQwenSubscription(profile, REQUEST_MS);
  let id: string | undefined;
  return {
    account: async () => {
      const { status, accountLabel, plan, entitlement } = await client.account();
      return { status, entitlement, ...(accountLabel !== null && { accountLabel }), ...(plan !== undefined && { plan }) };
    },
    begin: async () => { id = (await client.startLogin()).id; },
    poll: async () => {
      if (id === undefined) throw failure();
      const flow = await client.loginStatus(id);
      const status = flow.status === "authorized" ? "ready" : flow.status === "unknown" ? "failed" : flow.status;
      return { status, ...(flow.authorizationUrl !== undefined && { challenge: { verificationUrl: flow.authorizationUrl } }) };
    },
    activate,
    cancel: async () => { if (id !== undefined) await client.cancelLogin(id); },
    logout: () => client.logout(),
    close,
  };
}
