import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import Markdown, { type Components } from "react-markdown";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ConversationView } from "@earendil-works/pi-durable";
import { entryUpdates, inputText, inWrittenOrder, liveUpdates, toolText } from "@chopin-ai/harness-pi/acp";

export type Item =
  | { kind: "user" | "agent" | "thought"; text: string }
  | { kind: "tool"; title: string; input: string; status: "running" | "completed" | "failed"; output: string };

/**
 * The conversation as items to draw: committed entries, each tool's result folded into its call, then what is being
 * generated. `settled`, the items of the committed entries, may come from an earlier fold of the same entries.
 */
export function fold(view: ConversationView, settled = settledItems(view.entries)): Item[] {
  return [...settled, ...liveItems(view)];
}

function settledItems(entries: ConversationView["entries"]): Item[] {
  return itemsOf(entries.flatMap((entry) => {
    let pieces = committed.get(entry);
    if (pieces === undefined) committed.set(entry, (pieces = entryUpdates(entry).flatMap(pieceOf)));
    return pieces;
  }));
}

function liveItems(view: ConversationView): Item[] {
  return itemsOf(liveUpdates(view).flatMap(pieceOf));
}

/** What one update shows, in the order it was written; a tool's result is folded into its call afterwards. */
type Piece =
  | { kind: "user" | "agent" | "thought"; text: string }
  | { kind: "call"; id: string; title: string; input: string }
  | { kind: "result"; id: string; failed: boolean; output: string };

/** The pieces of each committed entry, worked out once: an entry never changes once committed. */
const committed = new WeakMap<object, Piece[]>();

function pieceOf(update: SessionUpdate): Piece[] {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return [];
      const kind = update.sessionUpdate === "user_message_chunk" ? "user" : update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
      return [{ kind, text: inWrittenOrder(update.content.text) }];
    }
    case "tool_call":
      return [{ kind: "call", id: update.toolCallId, title: inWrittenOrder(update.title), input: inWrittenOrder(inputText(update.rawInput)) }];
    case "tool_call_update":
      return [{ kind: "result", id: update.toolCallId, failed: update.status === "failed", output: inWrittenOrder(toolText(update.content ?? [])) }];
    default:
      return [];
  }
}

function itemsOf(pieces: readonly Piece[]): Item[] {
  const items: Item[] = [];
  /** Where each tool call sits in `items`. */
  const tools = new Map<string, number>();
  for (const piece of pieces) {
    if (piece.kind === "call") {
      tools.set(piece.id, items.push({ kind: "tool", title: piece.title, input: piece.input, status: "running", output: "" }) - 1);
    } else if (piece.kind === "result") {
      const index = tools.get(piece.id);
      const item = index === undefined ? undefined : items[index];
      if (index !== undefined && item?.kind === "tool") items[index] = { ...item, status: piece.failed ? "failed" : "completed", output: piece.output };
    } else {
      items.push(piece);
    }
  }
  return items;
}

export function Transcript({ view }: { view: ConversationView }) {
  // Committed entries change only when one is added; what is being generated changes with every token.
  const settled = useMemo(() => settledItems(view.entries), [view.entries]);
  const items = fold(view, settled);
  const end = useRef<HTMLDivElement>(null);
  const following = useFollowing(end);
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
  });
  return (
    <div className="transcript">
      {/* Items only grow at the end, and one being generated is committed in its place, so a position names one item for good. */}
      {items.map((item, i) => <Entry key={i} item={item} />)}
      <div ref={end} />
    </div>
  );
}

/** Whether the reader is at the end, so new output keeps it in view; scrolling up to read earlier output stops that. */
function useFollowing(end: RefObject<HTMLDivElement | null>): RefObject<boolean> {
  const following = useRef(true);
  useEffect(() => {
    const marker = end.current;
    if (marker === null) return;
    const watch = new IntersectionObserver((entries) => {
      following.current = entries.at(-1)?.isIntersecting ?? following.current;
    });
    watch.observe(marker);
    return () => watch.disconnect();
  }, [end]);
  return following;
}

/** Folding rebuilds every item on each update; an entry whose content is unchanged is not rendered again. */
const Entry = memo(EntryView, (before, after) => sameItem(before.item, after.item));

function sameItem(a: Item, b: Item): boolean {
  const after: Record<string, unknown> = b;
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => after[key] === value);
}

/**
 * Links in the agent's text open beside the app. An image it names is shown as its name, its address on hover:
 * fetching it unasked would send whatever the address carries.
 */
const AGENT_MARKDOWN: Components = {
  a: ({ href, children }) => <a href={href || undefined} target="_blank" rel="noreferrer noopener">{children}</a>,
  img: ({ src, alt }) => {
    const address = typeof src === "string" && src !== "" ? src : undefined;
    return <span className="image" title={address}>{`[image: ${alt || address || "unnamed"}]`}</span>;
  },
};

function EntryView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <div className="user">{item.text}</div>;
    case "agent":
      return <div className="agent"><Markdown components={AGENT_MARKDOWN}>{item.text}</Markdown></div>;
    case "thought":
      return <details className="thought"><summary>Thinking</summary>{item.text}</details>;
    case "tool":
      return (
        <details className={`tool ${item.status}`}>
          <summary><span className="mark" />{item.title} <code>{item.input}</code></summary>
          {item.output !== "" && <pre>{item.output}</pre>}
        </details>
      );
  }
}
