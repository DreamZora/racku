/**
 * How fresh the page's data is, and the state of its connection to the rack: whether the rack
 * answers, since when it doesn't, and why. This module uses no API of the DOM or of Bun, so that
 * tests run it in Bun.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
 */

/** Why a request failed: the dashboard's HTTP status, 0 when it didn't answer, and a reason. */
export interface Failure {
  /** The HTTP status, such as 502; 200 for an answer of the rack that failed; 0 for none. */
  status: number;
  /** A reason for people. */
  reason: string;
}

/** The outcomes of one kind of request: when it last succeeded, and since when it fails. */
export class Freshness {
  /** When the last request succeeded, a millisecond timestamp; `null` before one did. */
  lastOk: number | null = null;
  /** When the first of the failures since then came, a millisecond timestamp; `null` while none. */
  failingSince: number | null = null;
  /** The last failure since then; `null` while none. */
  failure: Failure | null = null;

  /**
   * Records a request that succeeded.
   *
   * @param time When its answer came, a millisecond timestamp.
   */
  ok(time: number): void {
    this.lastOk = time;
    this.failingSince = null;
    this.failure = null;
  }

  /**
   * Records a request that failed.
   *
   * @param time When it failed, a millisecond timestamp.
   * @param failure Why.
   */
  fail(time: number, failure: Failure): void {
    if (this.failingSince === null) this.failingSince = time;
    this.failure = failure;
  }

  /**
   * How old the data from the last success is.
   *
   * @param now The current time, a millisecond timestamp.
   * @returns The age in ms, or `null` before a request succeeded.
   */
  age(now: number): number | null {
    return this.lastOk === null ? null : Math.max(0, now - this.lastOk);
  }

  /** Whether the last request failed. */
  get failing(): boolean {
    return this.failingSince !== null;
  }
}

/** The state of the page's connection to the rack, from the outcomes of its `status` requests. */
export type Connection =
  /** No request has ended yet. */
  | { state: "connecting" }
  /** The rack answers; `age` is how old the data is, in ms. */
  | { state: "live"; age: number }
  /**
   * The rack doesn't answer: since when, why, and how old the last data is, `null` when the page
   * has none.
   */
  | { state: "down"; since: number; reason: string; status: number; age: number | null }
  /** The dashboard refused the page's token, with 401: only the URL it printed helps. */
  | { state: "unauthorized" }
  /** The dashboard refused the page itself, with 403, such as one reached by a domain name. */
  | { state: "refused" };

/**
 * The state of the connection.
 *
 * @param status The outcomes of the page's `status` requests, which the rack answers at once.
 * @param now The current time, a millisecond timestamp.
 * @returns The state.
 */
export function connectionOf(status: Freshness, now: number): Connection {
  const failure = status.failure;
  if (failure?.status === 401) return { state: "unauthorized" };
  if (failure?.status === 403) return { state: "refused" };
  if (status.failingSince !== null && failure !== null) {
    return {
      state: "down",
      since: status.failingSince,
      reason: failure.reason,
      status: failure.status,
      age: status.age(now),
    };
  }
  if (status.lastOk !== null) return { state: "live", age: status.age(now) ?? 0 };
  return { state: "connecting" };
}

/**
 * Whether a failure ends the page's polling: the dashboard refused the token or the page, and
 * asking again can't change that.
 *
 * @param failure A failure.
 */
export function isFinal(failure: Failure): boolean {
  return failure.status === 401 || failure.status === 403;
}
