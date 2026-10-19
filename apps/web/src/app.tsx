import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import type { Host } from "@earendil-works/chord";
import type { ConversationView } from "@earendil-works/pi-durable";
import { inWrittenOrder, isRunning } from "@chopin-ai/harness-pi/acp";
import { call, connect, Conversation, Conversations, endText, errorText, lastFailure, MODES, resender, type Mode } from "@chopin-ai/harness-pi/protocol";
import { useValue } from "./state";
import { Transcript } from "./transcript";

const holdList = (host: Host) => host.hold(Conversations, {});
const holdOne = (host: Host, conversation: number) => host.hold(Conversation, { conversation });
type ListRef = ReturnType<typeof holdList>;
type ConversationRef = ReturnType<typeof holdOne>;

const MODE_LABELS: Readonly<Record<Mode, string>> = { full: "full", read: "read only" };

/** The page's one connection; the browser sends the credential cookie with it. */
const host = connect(new URL(".", location.href.replace(/^http/, "ws")));

export function App() {
  const [list, shown] = useHeld(() => holdList(host), []);
  const [selected, setSelected] = useState<number>();

  if (list?.status === "gone") return <p className="notice">Could not open the agent: {inWrittenOrder(endText(list))}. Reload to try again.</p>;
  if (list === undefined || !shown) return <Connecting />;
  return (
    <div className="app">
      {list.status === "loading" && <p className="notice">Reconnecting…</p>}
      <Sidebar list={list} selected={selected} onSelect={setSelected} />
      <main>{selected === undefined ? <p className="notice">Start a conversation.</p> : <Pane key={selected} id={selected} />}</main>
    </div>
  );
}

/** Waiting for the service; one that has ended is never coming back at this address. */
function Connecting() {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLong(true), 10_000);
    return () => clearTimeout(timer);
  }, []);
  return <p className="notice">Connecting…{long && <> If the service has ended, start it again; for a project on this machine, run <code>chopin web</code> in its folder.</>}</p>;
}

/**
 * An object the server holds for this page while the component shows it. `hold` hands it over at once, still
 * loading; the component draws again on every change of its status and releases it once it is no longer shown.
 */
function useHeld<R extends Held>(hold: () => R, deps: readonly unknown[]): [R | undefined, boolean] {
  const [held, setHeld] = useState<R>();
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  // Whether it has been live, seen at every change of status: a reconnect keeps its last state, so it stays on screen.
  const shown = useRef(false);
  useEffect(() => {
    const ref = hold();
    shown.current = ref.status === "live";
    setHeld(ref);
    const stop = ref.onStatus((status) => {
      if (status === "live") shown.current = true;
      if (status === "gone" || status === "released") shown.current = false;
      redraw();
    });
    return () => {
      stop();
      ref.release();
    };
  }, deps);
  return [held, shown.current];
}

type Held = { readonly status: string; onStatus(listener: (status: string) => void): () => void; release(): void };

/** An error's text, in the order it was written. */
function message(error: unknown): string {
  return inWrittenOrder(errorText(error));
}

/** Runs an action and reports its failure, so nothing a click starts can fail unseen; resolves whether it worked. */
function useAction(): [string | undefined, (work: () => Promise<unknown>) => Promise<boolean>] {
  const [failure, setFailure] = useState<string>();
  const act = (work: () => Promise<unknown>) => {
    setFailure(undefined);
    return work().then(() => true, (error: unknown) => {
      setFailure(message(error));
      return false;
    });
  };
  return [failure, act];
}

function Sidebar({ list, selected, onSelect }: { list: ListRef; selected: number | undefined; onSelect(id: number): void }) {
  const ids = useValue(list.ids);
  const [failure, act] = useAction();
  // One start at a time, so a second click does not leave an empty conversation behind.
  const [creating, setCreating] = useState(false);
  const create = () => {
    setCreating(true);
    void act(async () => onSelect(await call(host, (ctx) => list.create(ctx)))).finally(() => setCreating(false));
  };
  return (
    <nav>
      <button onClick={create} disabled={creating}>New conversation</button>
      {failure !== undefined && <p className="failure">{failure}</p>}
      <ul>
        {[...ids].reverse().map((id) => (
          <li key={id}><button className={id === selected ? "selected" : ""} onClick={() => onSelect(id)}>Conversation {id}</button></li>
        ))}
      </ul>
    </nav>
  );
}

function Pane({ id }: { id: number }) {
  const [conversation, shown] = useHeld(() => holdOne(host, id), [id]);
  if (conversation?.status === "gone") return <p className="failure">Could not open conversation {id}: {inWrittenOrder(endText(conversation))}</p>;
  return conversation !== undefined && shown ? <ConversationView id={id} conversation={conversation} /> : <p className="notice">Opening…</p>;
}

function ConversationView({ id, conversation }: { id: number; conversation: ConversationRef }) {
  const view = useValue(conversation.view) as ConversationView;
  const mode = useValue(conversation.mode);
  const failed = lastFailure(useValue(conversation.submissions));
  const unanswered = failed === undefined ? undefined : inWrittenOrder(failed);
  const busy = isRunning(view);
  const modelId = (view.docs["pi.agent"]?.model as { modelId?: string } | undefined)?.modelId;
  const model = modelId === undefined ? undefined : inWrittenOrder(modelId);
  const [failure, act] = useAction();
  return (
    <>
      <header>
        <span>{model ?? "model"}</span>
        <select value={mode} onChange={(e) => {
          const next = MODES.find((known) => known === e.target.value);
          if (next !== undefined) act(() => call(host, (ctx) => conversation.setMode({ mode: next }, ctx)));
        }}>
          {MODES.map((known) => <option key={known} value={known}>{MODE_LABELS[known]}</option>)}
        </select>
        <span className="status">
          {failure ?? (conversation.status === "loading" ? "reconnecting…" : busy ? "working" : unanswered === undefined ? "ready" : `no answer: ${unanswered}`)}
        </span>
      </header>
      <Transcript view={view} />
      <Composer
        id={id}
        busy={busy}
        send={(text) => act(() => senderOf(id)(text, (request) => call(host, (ctx) => conversation.submit({ text, request }, ctx))))}
        stop={() => act(() => call(host, (ctx) => conversation.abort({}, ctx)))}
      />
    </>
  );
}

/** Unsent messages by conversation, kept while a reconnect redraws the conversation. */
const drafts = new Map<number, string>();

/** How each conversation sends, so a resend after a failure is admitted once; kept while a reconnect redraws it. */
const senders = new Map<number, ReturnType<typeof resender>>();

function senderOf(id: number): ReturnType<typeof resender> {
  let send = senders.get(id);
  if (send === undefined) senders.set(id, (send = resender()));
  return send;
}

function Composer({ id, busy, send, stop }: { id: number; busy: boolean; send(text: string): Promise<boolean>; stop(): void }) {
  const [text, setTextState] = useState(() => drafts.get(id) ?? "");
  const setText = (value: string) => {
    drafts.set(id, value);
    setTextState(value);
  };
  const submit = () => {
    const sent = text.trim();
    if (sent === "") return;
    setText("");
    // A message that could not be sent comes back, unless something new has been typed meanwhile.
    void send(sent).then((delivered) => {
      if (!delivered && (drafts.get(id) ?? "") === "") setText(sent);
    });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <footer>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keyDown} placeholder="Message the agent; Shift+Enter for a new line" rows={3} />
      {busy ? <button onClick={stop}>Stop</button> : <button onClick={submit}>Send</button>}
    </footer>
  );
}
