/** Waits that double from `first` up to `last`, back to `first` on `reset`. */
export function backoff(first: number, last: number): { next(): number; reset(): void } {
  let wait = first;
  return {
    next: () => {
      const now = wait;
      wait = Math.min(wait * 2, last);
      return now;
    },
    reset: () => void (wait = first),
  };
}
