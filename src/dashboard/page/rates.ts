/**
 * Rates from the rack's counters: the difference between two readings, over the time between
 * them. A device's counters restart when its instance changes, which its `firmware` or `since`
 * shows, and that interval gives no rate. Nor do the interval that a reading which came late
 * ends, and the next one, since the page doesn't know when the rack read it. The page keeps 60
 * readings per device for its charts. This module uses no API of the DOM or of Bun, so that tests
 * run it in Bun.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */
import type {
  CalledRpcMetrics,
  DeviceMetrics,
  EmittedEventMetrics,
  OutsideMetrics,
  ReceivedEventMetrics,
  ServedRpcMetrics,
} from "../../metrics.ts";

/** The most readings the page keeps per device, 2 minutes of them at one every 2 s. */
export const READINGS_PER_DEVICE = 60;

/**
 * How long an answer of `metrics()` may take, in ms, for the page to date its devices' counters
 * by the answer: 1 s. The rack reads each device's counters when that device's Worker answers,
 * and waits for the slowest up to `hookTimeout`, so the counters in a later answer were read at
 * times that the page doesn't know: while one device blocks its event loop for seconds, the
 * others would show a false dip, then a spike. Such a reading gives no device a rate, for the
 * interval it ends or the next one, as a failed read and a restarted instance give none. The
 * calls from outside keep their rates: the rack reads their counters last, as it answers.
 */
export const LATE_READING_MS = 1_000;

/** The counters of one member of a port or a need, of any kind. */
export type MemberCounters =
  | ServedRpcMetrics
  | CalledRpcMetrics
  | EmittedEventMetrics
  | ReceivedEventMetrics;

/**
 * The rate of a counter between two readings.
 *
 * @param before The counter at the earlier reading.
 * @param after The counter at the later reading.
 * @param seconds The time between the readings.
 * @returns Per second, or `null` when the counter went down, which only a restart does, or the
 *   interval isn't longer than 0.
 */
export function counterRate(before: number, after: number, seconds: number): number | null {
  if (!(seconds > 0) || !Number.isFinite(before) || !Number.isFinite(after) || after < before) {
    return null;
  }
  return (after - before) / seconds;
}

/**
 * Adds up counts by error code.
 *
 * @param errors Counts by error code.
 * @returns Their sum.
 */
export function errorTotal(errors: Record<string, number>): number {
  let total = 0;
  for (const count of Object.values(errors)) if (Number.isFinite(count)) total += count;
  return total;
}

/** What tells one instance of a device from another: its firmware, and when it booted. */
export interface InstanceKey {
  firmware: string;
  since: number;
}

/**
 * Whether two readings of a device's counters come from the same instance, so that their
 * difference is a rate.
 *
 * @param a The earlier reading.
 * @param b The later reading.
 */
export function sameInstance(a: InstanceKey, b: InstanceKey): boolean {
  return a.firmware === b.firmware && a.since === b.since;
}

/** The counters of an RPC member that a mean comes from. */
export interface FinishedCalls {
  ok: number;
  errors: Record<string, number>;
  timeMs: number;
}

/**
 * The mean duration of the calls that finished between two readings: the difference of their
 * total time over the difference of their count.
 *
 * @param before The counters at the earlier reading; absent counters count as zeros, as a
 *   member's counters do before its first call.
 * @param after The counters at the later reading.
 * @returns The mean in ms, or `null` when no call finished in between, or the counters went down.
 */
export function intervalMean(
  before: FinishedCalls | undefined,
  after: FinishedCalls,
): number | null {
  const calls =
    after.ok +
    errorTotal(after.errors) -
    (before === undefined ? 0 : before.ok + errorTotal(before.errors));
  const time = after.timeMs - (before?.timeMs ?? 0);
  if (!(calls > 0) || !(time >= 0)) return null;
  return time / calls;
}

/** The rates of one member over one interval. */
export interface MemberRates {
  /** Calls per second of an RPC member; events per second of an event member. */
  rate: number | null;
  /**
   * Failed calls per second of an RPC member; dropped deliveries per second of an event member
   * that the device emits; `null` for one that it receives.
   */
  errors: number | null;
  /** The mean duration of the calls that finished in the interval, in ms; `null` for events. */
  meanMs: number | null;
}

const NO_RATES: MemberRates = { rate: null, errors: null, meanMs: null };

/**
 * The rates of a member between two readings of its counters.
 *
 * @param before Its counters at the earlier reading; absent counters count as zeros.
 * @param after Its counters at the later reading.
 * @param seconds The time between the readings.
 * @returns The rates; all `null` when the interval gives none.
 */
export function memberRates(
  before: MemberCounters | undefined,
  after: MemberCounters,
  seconds: number,
): MemberRates {
  if (before !== undefined && before.kind !== after.kind) return { ...NO_RATES };
  if (after.kind === "rpc") {
    const earlier = before as ServedRpcMetrics | CalledRpcMetrics | undefined;
    return {
      rate: counterRate(earlier?.calls ?? 0, after.calls, seconds),
      errors: counterRate(errorTotal(earlier?.errors ?? {}), errorTotal(after.errors), seconds),
      meanMs: seconds > 0 ? intervalMean(earlier, after) : null,
    };
  }
  if ("emitted" in after) {
    const earlier = before as EmittedEventMetrics | undefined;
    return {
      rate: counterRate(earlier?.emitted ?? 0, after.emitted, seconds),
      errors: counterRate(earlier?.dropped ?? 0, after.dropped, seconds),
      meanMs: null,
    };
  }
  const earlier = before as ReceivedEventMetrics | undefined;
  return {
    rate: counterRate(earlier?.received ?? 0, after.received, seconds),
    errors: null,
    meanMs: null,
  };
}

/** Rates by port or need, then by member. */
export type RatesByMember = Record<string, Record<string, MemberRates>>;

/** The rates of one device over the interval that ended with its last reading. */
export interface DeviceRates {
  /** When the later reading came, a millisecond timestamp of the page's clock. */
  time: number;
  /** The length of the interval in seconds; 0 for the device's first reading. */
  seconds: number;
  /**
   * Whether the counters restarted in the interval: the reading came from another instance than
   * the one before, as its `firmware` or `since` shows, so the interval gives no rate.
   */
  restarted: boolean;
  /**
   * Whether the reading, or the one before it, came late, more than {@link LATE_READING_MS} after
   * its request: the page doesn't know when the rack read the counters, so the interval gives no
   * rate.
   */
  late: boolean;
  /** The rates of the members of the ports it provides. */
  provides: RatesByMember;
  /** The rates of the members of its needs. */
  needs: RatesByMember;
}

/** One point of a device's chart: its rates over the interval that ended at `time`. */
export interface DevicePoint {
  /** When the reading came, a millisecond timestamp of the page's clock. */
  time: number;
  /** Calls the device served per second, over the RPC members of its ports. */
  served: number | null;
  /** Calls the device made per second, over the RPC members of its needs. */
  made: number | null;
  /** Calls that failed per second, served and made. */
  errors: number | null;
}

function ratesOf(
  before: Record<string, Record<string, MemberCounters>> | undefined,
  after: Record<string, Record<string, MemberCounters>>,
  seconds: number | null,
): RatesByMember {
  const result: RatesByMember = {};
  for (const [port, members] of Object.entries(after)) {
    const rates: Record<string, MemberRates> = {};
    for (const [member, counters] of Object.entries(members)) {
      rates[member] =
        seconds === null
          ? { ...NO_RATES }
          : memberRates(before?.[port]?.[member], counters, seconds);
    }
    result[port] = rates;
  }
  return result;
}

/** The sum of the call rates of the RPC members, or `null` when one of them has none. */
function callSum(
  counters: Record<string, Record<string, MemberCounters>>,
  rates: RatesByMember,
  field: "rate" | "errors",
): number | null {
  let sum = 0;
  for (const [port, members] of Object.entries(counters)) {
    for (const [member, counter] of Object.entries(members)) {
      if (counter.kind !== "rpc") continue;
      const value = rates[port]?.[member]?.[field];
      if (value === null || value === undefined) return null;
      sum += value;
    }
  }
  return sum;
}

/**
 * The readings of one device: the last one, the rates over the interval it ended, and up to
 * {@link READINGS_PER_DEVICE} points for its chart.
 */
export class DeviceTrack {
  /** The chart's points, oldest first; at most {@link READINGS_PER_DEVICE}. */
  readonly points: DevicePoint[] = [];
  /** The rates over the interval that ended with the last reading; `null` before one. */
  latest: DeviceRates | null = null;
  /** Whether the last answer of `metrics()` left the device out, or failed. */
  missing = false;
  #last: { time: number; counters: DeviceMetrics; late: boolean } | null = null;

  /** The last reading of the device's counters, or `null` before one. */
  get counters(): DeviceMetrics | null {
    return this.#last?.counters ?? null;
  }

  /** When the last reading came, a millisecond timestamp; `null` before one. */
  get readAt(): number | null {
    return this.#last?.time ?? null;
  }

  /**
   * Takes a reading of the device's counters.
   *
   * @param time When it came, a millisecond timestamp of the page's clock.
   * @param counters The device's entry of `metrics()`.
   * @param late Whether it came more than {@link LATE_READING_MS} after its request, so that the
   *   page doesn't know when the rack read it: then neither the interval it ends nor the next one
   *   gives a rate.
   */
  add(time: number, counters: DeviceMetrics, late = false): void {
    const last = this.#last;
    const restarted = last !== null && !sameInstance(last.counters, counters);
    const seconds = last === null ? 0 : (time - last.time) / 1000;
    // The page dates a reading by its answer, and a late answer may come seconds after the rack
    // read the counters: an interval that starts or ends at such a reading has no known length.
    const undated = late || last?.late === true;
    const rated = last !== null && !restarted && !undated && seconds > 0;
    const before = rated ? last.counters : undefined;
    const provides = ratesOf(before?.provides, counters.provides, rated ? seconds : null);
    const needs = ratesOf(before?.needs, counters.needs, rated ? seconds : null);
    this.latest = {
      time,
      seconds: Math.max(0, seconds),
      restarted,
      late: undated,
      provides,
      needs,
    };
    const served = callSum(counters.provides, provides, "rate");
    const made = callSum(counters.needs, needs, "rate");
    const servedErrors = callSum(counters.provides, provides, "errors");
    const madeErrors = callSum(counters.needs, needs, "errors");
    this.#push({
      time,
      served: rated ? served : null,
      made: rated ? made : null,
      errors:
        rated && servedErrors !== null && madeErrors !== null ? servedErrors + madeErrors : null,
    });
    this.#last = { time, counters, late };
    this.missing = false;
  }

  /**
   * Records a reading without the device: a gap in its chart. The last reading stays, so that the
   * next one of the same instance gives the rate over the longer interval.
   *
   * @param time When the answer came, or the request failed, a millisecond timestamp.
   */
  miss(time: number): void {
    this.#push({ time, served: null, made: null, errors: null });
    this.missing = true;
  }

  #push(point: DevicePoint): void {
    this.points.push(point);
    if (this.points.length > READINGS_PER_DEVICE) {
      this.points.splice(0, this.points.length - READINGS_PER_DEVICE);
    }
  }
}

/** The readings of every device, by name. */
export class Tracks {
  readonly #tracks = new Map<string, DeviceTrack>();

  /**
   * The readings of a device.
   *
   * @param name The device.
   * @returns Its track, or `undefined` before its first reading.
   */
  get(name: string): DeviceTrack | undefined {
    return this.#tracks.get(name);
  }

  /** The names of the devices with readings. */
  names(): string[] {
    return [...this.#tracks.keys()];
  }

  /**
   * Takes an answer of `metrics()`. A device that it leaves out gets a gap; a device that the rack
   * no longer has is forgotten, so that what the page keeps stays bounded.
   *
   * @param time When the answer came, a millisecond timestamp of the page's clock.
   * @param devices The answer's `devices`.
   * @param present The names of the devices that `status()` last reported, or `null` before it
   *   answered once.
   * @param late Whether the answer came more than {@link LATE_READING_MS} after its request: then
   *   no device gets a rate for the interval it ends, or for the next one.
   */
  take(
    time: number,
    devices: readonly DeviceMetrics[],
    present: readonly string[] | null,
    late = false,
  ): void {
    const seen = new Set<string>();
    for (const counters of devices) {
      seen.add(counters.device);
      let track = this.#tracks.get(counters.device);
      if (track === undefined) {
        track = new DeviceTrack();
        this.#tracks.set(counters.device, track);
      }
      track.add(time, counters, late);
    }
    for (const [name, track] of this.#tracks) {
      if (seen.has(name)) continue;
      if (present !== null && !present.includes(name)) this.#tracks.delete(name);
      else track.miss(time);
    }
  }

  /**
   * Records a failed read of `metrics()`: a gap for every device.
   *
   * @param time When the request failed, a millisecond timestamp.
   */
  fail(time: number): void {
    for (const track of this.#tracks.values()) track.miss(time);
  }

  /**
   * Forgets every device that the rack no longer has.
   *
   * @param present The names of the devices that `status()` reported.
   */
  keep(present: readonly string[]): void {
    for (const name of [...this.#tracks.keys()]) {
      if (!present.includes(name)) this.#tracks.delete(name);
    }
  }
}

/** The rates of one address and member of the calls from outside the rack. */
export interface OutsideRow {
  /** `<device>.<port>`. */
  address: string;
  member: string;
  rates: MemberRates;
  /** Its counters at the last reading. */
  counters: CalledRpcMetrics;
}

/**
 * The rates of the calls from outside the rack. The rack's main thread keeps their counters, so
 * they last across swaps; a port's counters start at its first call.
 */
export class OutsideTrack {
  /** One row per address and member, sorted by address, then member. */
  rows: OutsideRow[] = [];
  /** Calls from outside per second, every address and member and the unrouted ones together. */
  total: number | null = null;
  /** The calls that reached no port: their count, and their rate. */
  unrouted: { count: number; rate: number | null } | null = null;
  #last: { time: number; outside: OutsideMetrics } | null = null;

  /** When the last reading came, a millisecond timestamp; `null` before one. */
  get readAt(): number | null {
    return this.#last?.time ?? null;
  }

  /**
   * Takes a reading of the counters.
   *
   * @param time When it came, a millisecond timestamp of the page's clock.
   * @param outside The answer's `outside`.
   */
  take(time: number, outside: OutsideMetrics): void {
    const last = this.#last;
    const seconds = last === null ? 0 : (time - last.time) / 1000;
    const rated = last !== null && seconds > 0;
    const rows: OutsideRow[] = [];
    let total: number | null = rated ? 0 : null;
    for (const address of Object.keys(outside.ports).sort()) {
      const members = outside.ports[address] ?? {};
      for (const member of Object.keys(members).sort()) {
        const counters = members[member] as CalledRpcMetrics;
        const rates = rated
          ? memberRates(last.outside.ports[address]?.[member], counters, seconds)
          : { ...NO_RATES };
        if (total !== null) total = rates.rate === null ? null : total + rates.rate;
        rows.push({ address, member, rates, counters });
      }
    }
    const unroutedRate = rated
      ? counterRate(last.outside.unrouted, outside.unrouted, seconds)
      : null;
    this.rows = rows;
    this.unrouted = { count: outside.unrouted, rate: unroutedRate };
    this.total = total === null || unroutedRate === null ? null : total + unroutedRate;
    this.#last = { time, outside };
  }
}
