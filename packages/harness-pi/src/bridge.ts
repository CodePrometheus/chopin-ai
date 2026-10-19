import { AgentSideConnection, PROTOCOL_VERSION, RequestError, type Agent, type PromptRequest, type PromptResponse, type Stream } from "@agentclientprotocol/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import type { Ctx, Host } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { entryUpdates, runInputs, stopReason, unansweredText } from "./acp.js";
import {
  call,
  CALL_TIMEOUT_MS,
  CallTimeout,
  heldList,
  randomId,
  startConversation,
  within,
  type CallOptions,
  type ConversationRef,
  type HeldList,
} from "./protocol.js";
import { lost as lostOutcome, type Outcome as SubmissionOutcome } from "./submissions.js";

/** How a prompt's submission ended, or that the client went away, or that the conversation itself did. */
type Outcome = SubmissionOutcome | { status: "gone" } | { status: "ended" };

const AWAY = "the service stopped answering";
const RESEND_WAIT_MS = 250;

/** A request the service could not answer, however that came to be known. */
function lostService(detail = AWAY): RequestError {
  return RequestError.internalError({ reason: "lost", detail }, `the agent did not answer: ${unansweredText({ reason: "lost", detail })}`);
}

export interface BridgeOptions {
  /** How long a request waits for a service it lost to come back before it fails; `CALL_TIMEOUT_MS` by default. */
  lostAfterMs?: number;
}

/**
 * Speaks ACP on `stream` for the agent behind `client`, a host connected to the agent service, so any ACP client
 * can drive it. One ACP session is one conversation.
 */
export function serveAcp(stream: Stream, client: Host, options: BridgeOptions = {}): AgentSideConnection {
  let bridge: Bridge | undefined;
  const lostAfterMs = options.lostAfterMs ?? CALL_TIMEOUT_MS;
  const connection = new AgentSideConnection((opened) => (bridge = new Bridge(opened, client, lostAfterMs)), stream);
  void connection.closed.finally(() => bridge?.release());
  return connection;
}

class Bridge implements Agent {
  readonly #connection: AgentSideConnection;
  readonly #client: Host;
  readonly #lostAfterMs: number;
  readonly #sessions = new Map<string, Promise<ConversationRef>>();
  /** Aborted once the client is gone. */
  readonly #gone = new AbortController();
  readonly #list: HeldList;

  constructor(connection: AgentSideConnection, client: Host, lostAfterMs: number) {
    this.#connection = connection;
    this.#client = client;
    this.#lostAfterMs = lostAfterMs;
    this.#list = heldList(client, { timeoutMs: lostAfterMs, signal: this.#gone.signal });
  }

  /** Lets go of every session's conversation, and ends the prompts still waiting, once the client is gone. */
  async release(): Promise<void> {
    this.#gone.abort();
    this.#list.release();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map(async (session) => (await session.catch(() => undefined))?.release()));
  }

  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    const { id, conversation } = await this.#reach((options) => startConversation(this.#client, this.#list.get, options));
    if (this.#gone.signal.aborted) {
      conversation.release();
      throw RequestError.internalError(undefined, "the client has gone");
    }
    this.#sessions.set(String(id), Promise.resolve(conversation));
    return { sessionId: String(id) };
  }

  async prompt({ sessionId, prompt }: PromptRequest): Promise<PromptResponse> {
    const conversation = await this.#session(sessionId);
    // Text and resource links are what every ACP agent takes; a link reaches the model as its name and its address.
    const text = prompt.flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "resource_link") return [`${block.name} <${block.uri}>`];
      return [];
    }).join("\n");
    if (text.trim() === "") throw RequestError.invalidParams(undefined, "the prompt has no text or link");

    const sent = new Set(view(conversation).entries.map((entry) => entry.id));
    const answers: AssistantMessage[] = [];
    let forwarding = Promise.resolve();
    let undelivered: unknown;
    // Committed entries go out in order, each once; the client already has its own prompt.
    const forward = () => {
      forwarding = forwarding.then(async () => {
        if (conversation.status !== "live") return;
        for (const entry of view(conversation).entries.filter((e) => !sent.has(e.id))) {
          sent.add(entry.id);
          answers.push(...(entry.model ?? []).filter((m): m is AssistantMessage => m.role === "assistant"));
          for (const update of entryUpdates(entry)) {
            if (update.sessionUpdate !== "user_message_chunk") await this.#connection.sessionUpdate({ sessionId, update });
          }
        }
      }).catch((error: unknown) => {
        undelivered ??= error;
      });
    };

    const submission = await this.#send(sessionId, conversation, text);
    const outcome = await this.#follow(sessionId, conversation, submission, forward);
    if (outcome.status === "gone") return { stopReason: "cancelled" };
    if (outcome.status === "ended") throw RequestError.resourceNotFound(sessionId);
    forward();
    await forwarding;
    if (undelivered !== undefined) throw undelivered;
    if (outcome.status === "unanswered") {
      if (outcome.reason === "aborted") return { stopReason: "cancelled" };
      if (outcome.reason === "lost") throw lostService(outcome.detail);
      const why = unansweredText({ reason: outcome.reason ?? "unknown", detail: outcome.detail });
      throw RequestError.internalError({ reason: outcome.reason, detail: outcome.detail }, `the agent did not answer: ${why}`);
    }
    return { stopReason: stopReason(answers.at(-1)) };
  }

  /**
   * Submits `text` under a request of its own, so it can be sent again when the link fails mid-call: the service
   * admits it once, whether or not the first try reached it.
   */
  async #send(sessionId: string, conversation: ConversationRef, text: string): Promise<number> {
    const request = randomId();
    // One bound for every try, so a send waits no longer than any other request.
    return this.#reach((options) => within(options, async (signal) => {
      for (;;) {
        // Only a call whose link wavered while it ran is sent again; one on a steady link failed for what it is.
        let wavered = false;
        const stop = conversation.onStatus(() => void (wavered = true));
        try {
          return await this.#client.root((ctx) => conversation.submit({ text, request }, ctx), { signal });
        } catch (error) {
          // The link's own news may trail the call's failure by a turn of the event loop.
          await sleep(0);
          if (conversation.status === "gone" || conversation.status === "released") {
            this.#forget(sessionId, conversation);
            throw RequestError.resourceNotFound(sessionId);
          }
          if (!wavered && conversation.status === "live") throw error;
          await sleep(RESEND_WAIT_MS, undefined, { signal });
        } finally {
          stop();
        }
      }
    }));
  }

  async cancel({ sessionId }: { sessionId: string }) {
    const conversation = await this.#session(sessionId);
    await this.#call((ctx) => conversation.abort({}, ctx));
  }

  /**
   * How `submission` ends: once it has settled and the view no longer shows it running, so the last answer is in
   * the view. A reconnect brings the object's state back as the store has it; a service that stays away, or a
   * conversation that ended, takes the session with it.
   */
  #follow(sessionId: string, conversation: ConversationRef, submission: number, changed: () => void): Promise<Outcome> {
    const stops: (() => void)[] = [];
    let ended = false;
    return new Promise<Outcome>((resolve) => {
      const settle = (outcome: Outcome) => {
        if (ended) return;
        ended = true;
        resolve(outcome);
      };
      const lost = (detail: string) => settle(lostOutcome(detail));
      const check = () => {
        if (ended || conversation.status !== "live") return;
        changed();
        const current = conversation.submissions.value[String(submission)];
        if (current !== undefined && current.status !== "pending" && !runInputs(view(conversation)).includes(submission)) settle(current);
      };
      let away: NodeJS.Timeout | undefined;
      const followed = (status: string) => {
        if (ended) return;
        clearTimeout(away);
        if (status === "live") {
          check();
        } else if (status === "loading") {
          away = setTimeout(() => {
            lost(AWAY);
            this.#forget(sessionId, conversation);
          }, this.#lostAfterMs);
        } else {
          settle({ status: "ended" });
          this.#forget(sessionId, conversation);
        }
      };
      // The agent keeps working for a client that has gone, but nobody waits for it here any longer.
      const gone = () => settle({ status: "gone" });
      this.#gone.signal.addEventListener("abort", gone, { once: true });
      stops.push(() => clearTimeout(away), () => this.#gone.signal.removeEventListener("abort", gone));
      // Subscribing delivers the current value at once, so the outcome may already be known here.
      stops.push(conversation.view.subscribe(check), conversation.submissions.subscribe(check), conversation.onStatus(followed));
      // Status listeners hear only of changes; one that already happened is taken as it stands.
      if (conversation.status !== "live") followed(conversation.status);
      if (this.#gone.signal.aborted) gone();
    }).finally(() => stops.forEach((stop) => stop()));
  }

  /** A held conversation, once it is live: waiting out a reconnect, but no longer than the service may stay away. */
  async #session(sessionId: string): Promise<ConversationRef> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw RequestError.resourceNotFound(sessionId);
    const conversation = await session;
    await this.#reach((options) => within(options, (signal) => this.#live(sessionId, conversation, signal)));
    return conversation;
  }

  /** Resolves once the session's conversation is live; one that ended takes the session with it. */
  #live(sessionId: string, conversation: ConversationRef, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settled = (status: string) => {
        if (status === "loading") return;
        stop();
        signal.removeEventListener("abort", aborted);
        if (status === "live") return resolve();
        this.#forget(sessionId, conversation);
        reject(RequestError.resourceNotFound(sessionId));
      };
      const aborted = () => {
        stop();
        reject(signal.reason);
      };
      const stop = conversation.onStatus(settled);
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
      settled(conversation.status);
    });
  }

  #forget(sessionId: string, conversation: ConversationRef): void {
    this.#sessions.delete(sessionId);
    conversation.release();
  }

  /** A method call on an object the bridge holds, through any reconnect, as long as the service may stay away. */
  #call<T>(work: (ctx: Ctx) => Promise<T>): Promise<T> {
    return this.#reach((options) => call(this.#client, work, options));
  }

  /** Any wait on the service, for as long as it may stay away and the client is here. */
  async #reach<T>(work: (options: CallOptions) => Promise<T>): Promise<T> {
    try {
      return await work({ timeoutMs: this.#lostAfterMs, signal: this.#gone.signal });
    } catch (error) {
      throw error instanceof CallTimeout || this.#gone.signal.aborted ? lostService() : error;
    }
  }
}

function view(conversation: ConversationRef): ConversationView {
  return conversation.view.value as ConversationView;
}
