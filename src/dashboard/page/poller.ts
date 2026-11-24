/**
 * The page's polling: each kind of request runs on a timer of its own, and waits for its answer
 * before the next one, so that a tick that finds the last request still waiting is skipped. This
 * module uses no API of the DOM or of Bun; the page hands it the timers.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */

/** How often the page asks for each kind of data, in ms. */
export const POLL_INTERVALS = {
  status: 1_000,
  history: 1_000,
  events: 1_000,
  metrics: 2_000,
} as const;

/** Runs a function every so often until cancelled. */
export interface Scheduler {
  /**
   * Calls `tick` every `ms` milliseconds.
   *
   * @returns A function that cancels the timer.
   */
  every(ms: number, tick: () => void): () => void;
}

/** One kind of request that a {@link Poller} repeats. */
export interface PollKind {
  /** The kind's name, such as `status`. */
  name: string;
  /** How often to start it, in ms. */
  intervalMs: number;
  /** Sends the request and takes its answer; the next one waits until it settles. */
  run(): Promise<void>;
}

/** Counts of one kind of request, for the page's tests and for people who look into it. */
export interface PollCounts {
  /** Requests started. */
  started: number;
  /** Ticks skipped because the last request still waited for its answer. */
  skipped: number;
}

/**
 * Repeats kinds of requests, one request in flight per kind.
 *
 * Starting runs every kind at once, then on its interval. A request that throws counts as settled,
 * and `onError` receives what it threw, so that one failure never stops the polling.
 */
export class Poller {
  readonly #kinds: readonly PollKind[];
  readonly #scheduler: Scheduler;
  readonly #onError: (kind: string, error: unknown) => void;
  readonly #waiting = new Set<string>();
  readonly #counts = new Map<string, PollCounts>();
  #cancels: Array<() => void> = [];

  /**
   * @param kinds The kinds of requests, each with its interval.
   * @param scheduler The timers.
   * @param onError Receives what a request threw; by default nothing does.
   */
  constructor(
    kinds: readonly PollKind[],
    scheduler: Scheduler,
    onError: (kind: string, error: unknown) => void = () => {},
  ) {
    this.#kinds = kinds;
    this.#scheduler = scheduler;
    this.#onError = onError;
    for (const kind of kinds) this.#counts.set(kind.name, { started: 0, skipped: 0 });
  }

  /** Whether the poller runs. */
  get running(): boolean {
    return this.#cancels.length > 0;
  }

  /** Starts every kind at once, then on its interval; a poller that runs already stays as it is. */
  start(): void {
    if (this.running) return;
    for (const kind of this.#kinds) {
      this.#cancels.push(this.#scheduler.every(kind.intervalMs, () => this.tick(kind.name)));
    }
    for (const kind of this.#kinds) this.tick(kind.name);
  }

  /** Stops the timers; a request that waits still settles, and starts no other. */
  stop(): void {
    for (const cancel of this.#cancels) cancel();
    this.#cancels = [];
  }

  /**
   * Starts a request of one kind, unless the last one still waits for its answer.
   *
   * @param name The kind.
   * @returns Whether a request started.
   */
  tick(name: string): boolean {
    const kind = this.#kinds.find((candidate) => candidate.name === name);
    const counts = this.#counts.get(name);
    if (kind === undefined || counts === undefined) return false;
    if (this.#waiting.has(name)) {
      counts.skipped++;
      return false;
    }
    this.#waiting.add(name);
    counts.started++;
    let pending: Promise<void>;
    try {
      pending = kind.run();
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .catch((error: unknown) => this.#onError(name, error))
      .finally(() => this.#waiting.delete(name));
    return true;
  }

  /**
   * Whether a request of a kind waits for its answer.
   *
   * @param name The kind.
   */
  waiting(name: string): boolean {
    return this.#waiting.has(name);
  }

  /**
   * The counts of a kind.
   *
   * @param name The kind.
   * @returns A copy of its counts; zeros for a kind the poller doesn't have.
   */
  counts(name: string): PollCounts {
    const counts = this.#counts.get(name);
    return counts === undefined ? { started: 0, skipped: 0 } : { ...counts };
  }
}
