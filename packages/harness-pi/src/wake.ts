import type { Wake } from "@earendil-works/pi-durable";

/** Serializes current activity observations without retaining intermediate projections. */
export class WakePublisher {
  readonly #observe: () => Promise<Wake>;
  readonly #publish: (wake: Wake) => void | Promise<void>;
  readonly #report: (error: unknown) => void;
  #last: Wake | undefined;
  #dirty = false;
  #closed = false;
  #running: Promise<void> | undefined;

  constructor(observe: () => Promise<Wake>, publish: (wake: Wake) => void | Promise<void>, report: (error: unknown) => void) {
    this.#observe = observe; this.#publish = publish; this.#report = report;
  }

  offer(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#running !== undefined) return;
    const running = this.#flush();
    this.#running = running;
    void running.finally(() => {
      this.#running = undefined;
      if (this.#dirty && !this.#closed) this.offer();
    });
  }

  /** Stops future publications and waits for a host update already in progress. */
  async close(): Promise<void> { this.#closed = true; await this.#running; }

  async #flush(): Promise<void> {
    while (this.#dirty && !this.#closed) {
      this.#dirty = false;
      try {
        const observed = await this.#observe();
        const wake = { active: observed.active, ...(observed.at !== undefined && { at: observed.at }) };
        if (this.#closed) return;
        if (this.#last?.active === wake.active && this.#last.at === wake.at) continue;
        const sent = { ...wake };
        await this.#publish(wake);
        this.#last = sent;
      } catch (error) {
        // Observation failure never publishes an invented idle state.
        try { this.#report(error); } catch { /* A failing reporter cannot repair the observation. */ }
      }
    }
  }
}
