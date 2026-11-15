import type { Self, Watchable } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { track, type Draft } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Principal } from "./protocol.js";

/** An object-owned presentation value; durable state stays in its source store. */
export interface Projection<T> {
  readonly value: T;
  readonly view: Watchable<T>;
  replace(context: Context, value: T): void;
  change(context: Context, change: (draft: Draft<T>) => void): void;
}

/** Initializes before the object goes live and publishes immutable JSON revisions. */
export function projection<T extends JsonValue>(self: Self<Principal>, initial: (context: Context) => T | Promise<T>): Projection<T> {
  const source = self.writable<T | undefined>(undefined);
  const current = () => {
    const value = source.value;
    if (value === undefined) throw new Error("projection is not initialized");
    return value;
  };
  const state = self.derive([source], current);
  self.open(async (context) => { source.set(await initial(context)); }, () => { });
  return {
    get value() { return state.value; },
    view: state,
    replace: (context, value) => { context.abortSignal?.throwIfAborted(); source.set(value); },
    change: (context, change) => {
      context.abortSignal?.throwIfAborted();
      const tracker = track({ value: current() });
      const draft = tracker.beginChange();
      try { change(draft.state.value); const prepared = draft.prepare(); tracker.adopt(prepared); source.set(prepared.value.value); }
      catch (error) { draft.abort(); throw error; }
    },
  };
}
