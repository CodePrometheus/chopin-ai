import { useCallback, useSyncExternalStore } from "react";

/** A state member of a remote object as a component sees it: a current value and a way to hear about the next one. */
export interface Observable<T> {
  readonly value: T;
  subscribe(listener: (value: T) => void): () => void;
}

export function useValue<T>(source: Observable<T>): T {
  const subscribe = useCallback((changed: () => void) => source.subscribe(() => changed()), [source]);
  return useSyncExternalStore(subscribe, () => source.value);
}
