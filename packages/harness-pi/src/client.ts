import { createHost, webSocketLink, type Contract, type Ctx, type HostError, type ParamsOf, type Reference } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { NativeWatchable, NativeWatchHandle, Watchable } from "@earendil-works/chord/watch";
import { backoff } from "./backoff.js";

/** Client-owned deadlines, independent of durable task lifetimes. */
export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Reconnect discovery supplies fresh addresses and credentials; application calls are never replayed here. */
export interface ConnectOptions {
  token?: string;
  find?: () => Promise<{ url: string | URL; token?: string }>;
  onError?: (error: HostError) => void;
}

/** Authenticated access to the service's objects, with an explicit connection lifetime. */
export interface Client {
  get<C extends Contract>(type: C, params: ParamsOf<C>, options?: CallOptions): Promise<Reference<C>>;
  root<T>(work: (context: Ctx) => Promise<T>, options?: CallOptions): Promise<T>;
  close(): Promise<void>;
}

export const CALL_TIMEOUT_MS = 30_000;
const HELD_MS = 5_000;

/** The operation deadline expired; a remote write may already have taken effect. */
export class CallTimeout extends Error {
  constructor(options?: ErrorOptions) { super("the agent service did not answer in time", options); }
}

/** Connects once, redialling lost links while retaining the source's reference lifecycle. */
export function connect(url: string | URL, options: ConnectOptions = {}): Client {
  const host = createHost({ onError: options.onError ?? ((error) => console.error(`agent connection: ${error.kind}`)) });
  const ready = host.load([], BACKGROUND_CONTEXT);
  let open = true;
  const waits = backoff(250, 10_000);
  let redial: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    if (!open) return;
    redial = setTimeout(() => {
      (options.find?.() ?? Promise.resolve({ url, token: options.token })).then(dial).catch(again);
    }, waits.next());
  };
  const dial = ({ url: at, token }: { url: string | URL; token?: string | undefined }) => {
    if (!open) return;
    const socket = token === undefined ? new WebSocket(at) : new WebSocket(at, { headers: { authorization: `Bearer ${token}` } });
    let opened: number | undefined;
    socket.addEventListener("open", () => void (opened = Date.now()));
    // The host owns the link's close listener; socket observation cannot replace it.
    socket.addEventListener("close", () => {
      if (opened !== undefined && Date.now() - opened >= HELD_MS) waits.reset();
      again();
    });
    host.connect(webSocketLink(socket), { principal: { kind: "host" } }, BACKGROUND_CONTEXT);
  };
  dial({ url, token: options.token });
  return {
    get: (type, params, call = {}) => within(call, async (signal) => {
      await ready;
      return host.get(type, params, withAbortSignal(signal, BACKGROUND_CONTEXT));
    }),
    root: (work, call = {}) => within(call, async (signal) => {
      await ready;
      return host.root(work, withAbortSignal(signal, BACKGROUND_CONTEXT));
    }),
    close: async () => {
      open = false;
      clearTimeout(redial);
      await ready;
      await host.close(BACKGROUND_CONTEXT);
    },
  };
}

/** Binds cancellation to one attempt; failures never rerun `work`. */
export async function within<T>(options: CallOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const bound = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const timeout = Number.isFinite(bound) ? AbortSignal.timeout(bound) : undefined;
  const signal = AbortSignal.any([timeout, options.signal].filter((each) => each !== undefined));
  try { return await work(signal); }
  catch (error) { throw timeout?.aborted === true ? new CallTimeout({ cause: error }) : error; }
}

/** Delivers the acquisition value, then changes, and releases a watch acquired after cancellation. */
export function subscribe<T>(source: Watchable<T> | NativeWatchable<T>, changed: (value: T) => void, failed: (error: unknown) => void): () => void {
  const abort = new AbortController();
  let watch: NativeWatchHandle<T> | undefined;
  void source.watch(withAbortSignal(abort.signal, BACKGROUND_CONTEXT)).then(async (opened) => {
    if (abort.signal.aborted) { await opened.stop(); return; }
    watch = opened;
    let ended = false;
    void opened.closed.then((end) => {
      ended = true;
      if (end.kind === "failed" || end.kind === "listener_error") failed(end.error);
    });
    changed(opened.value);
    await Promise.resolve();
    if (ended || abort.signal.aborted) return;
    opened.start(async (call) => {
      if (call.kind === "value") changed(call.value);
      else failed(call.error);
    });
  }).catch((error: unknown) => { void watch?.stop(); if (!abort.signal.aborted) failed(error); });
  return () => { abort.abort(); void watch?.stop(); };
}
