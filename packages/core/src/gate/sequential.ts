/**
 * A one-sided sequential test of the mean of bounded observations, by betting: wealth grows on observations above
 * `null` and shrinks below it, and is an e-value at any stopping time, so the test may stop whenever it likes without
 * losing its guarantee. Evidence against "the mean is at most `null`" is the wealth.
 */
export class BettingTest {
  readonly #null: number;
  readonly #low: number;
  readonly #alpha: number;
  #wealth = 1;
  #count = 0;
  #sum = 0;
  #squares = 0;

  /** Observations lie in [`low`, `high`]; `alpha` tunes how hard it bets, not its validity. */
  constructor(nullMean: number, low: number, high: number, alpha: number) {
    if (!(low < nullMean && nullMean < high)) throw new Error("the null mean must lie strictly inside the range");
    this.#null = nullMean;
    this.#low = low;
    this.#alpha = alpha;
  }

  get wealth(): number {
    return this.#wealth;
  }

  get count(): number {
    return this.#count;
  }

  get mean(): number | undefined {
    return this.#count === 0 ? undefined : this.#sum / this.#count;
  }

  add(observation: number): void {
    this.#wealth *= 1 + this.#bet() * (observation - this.#null);
    this.#count += 1;
    this.#sum += observation;
    this.#squares += observation * observation;
  }

  /** The predictable plug-in bet: sized by the variance seen so far, never enough to lose all the wealth. */
  #bet(): number {
    const t = this.#count + 1;
    const mean = this.#count === 0 ? this.#null : this.#sum / this.#count;
    const variance = this.#count < 2 ? 0.25 : Math.max(this.#squares / this.#count - mean * mean, 1e-3);
    const sized = Math.sqrt((2 * Math.log(1 / this.#alpha)) / (variance * t * Math.log(t + 1)));
    return Math.min(sized, 0.5 / (this.#null - this.#low));
  }
}

/** Where a comparison stands: enough evidence for, evidence against, or neither yet. */
export type Standing = "accept" | "reject" | "continue";

/**
 * Paired differences in [-1, 1], candidate minus reference, tested for a mean above `margin` (0 for "better",
 * minus a tolerance for "no worse"). It accepts once the evidence reaches `1 / alpha`, rejects once the evidence
 * that the mean is below `futilityMargin` reaches `1 / futility`, and rejects when `limit` pairs leave it undecided.
 * A `futilityMargin` above `margin` stops sooner on a candidate that cannot gain enough; stopping without accepting
 * never adds a false acceptance.
 */
export class PairedComparison {
  readonly for: BettingTest;
  readonly against: BettingTest;
  readonly #alpha: number;
  readonly #futility: number;
  readonly #limit: number;

  constructor(options: { margin: number; alpha: number; futility?: number; futilityMargin?: number; limit: number }) {
    this.#alpha = options.alpha;
    this.#futility = options.futility ?? 0.05;
    this.#limit = options.limit;
    this.for = new BettingTest(options.margin, -1, 1, options.alpha);
    // Against: the negated differences tested for a mean above -futilityMargin, that is, the mean below it.
    this.against = new BettingTest(-(options.futilityMargin ?? options.margin), -1, 1, this.#futility);
  }

  add(difference: number): Standing {
    this.for.add(difference);
    this.against.add(-difference);
    return this.standing;
  }

  get standing(): Standing {
    if (this.for.wealth >= 1 / this.#alpha) return "accept";
    if (this.against.wealth >= 1 / this.#futility || this.for.count >= this.#limit) return "reject";
    return "continue";
  }

  /** The e-value of the comparison, for the ledger. */
  get evidence(): number {
    return this.for.wealth;
  }
}
