/**
 * Tests of the dashboard page's logic: the modules of `src/dashboard/page/` that use no API of the
 * DOM, which the page's views draw from. They cover the client of the dashboard's API, the
 * polling with one request in flight per kind, rates from counters that restart, the feed's
 * records and the ones that dropped out, the bounds of what the page keeps, the state of the
 * connection and the age of its data, the operations, the token, and how values are written.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */
import { describe, expect, test } from "bun:test";
import {
  API_PATH,
  Client,
  type FetchAnswer,
  type FetchInit,
  OPERATION_WAIT_MS,
  type Outcome,
  READ_WAIT_MS,
} from "../src/dashboard/page/api.ts";
import { connectionOf, Freshness, isFinal } from "../src/dashboard/page/connection.ts";
import {
  describeRecord,
  FEED_LIMIT,
  Feed,
  filterRecords,
  type Level,
  levelOf,
} from "../src/dashboard/page/feed.ts";
import {
  errorText,
  formatAge,
  formatBytes,
  formatCount,
  formatData,
  formatDuration,
  formatErrorCodes,
  formatMean,
  formatRate,
  formatTime,
  formatWhen,
  MISSING,
  marksOf,
  shortHash,
  unitsText,
  visibleText,
} from "../src/dashboard/page/format.ts";
import {
  CHART_SPAN_MS,
  emptyUnits,
  nearestIndex,
  niceCeiling,
  placeOf,
  RACK_UNITS,
  runsOf,
  unitsOf,
} from "../src/dashboard/page/geometry.ts";
import { isMetrics, isStatusList, Model, startPolling } from "../src/dashboard/page/model.ts";
import {
  describeOutcome,
  Operations,
  reloadOperation,
  restartOperation,
  rollbackOperation,
  rollbackTargets,
  stopOperation,
  swapOperation,
} from "../src/dashboard/page/operations.ts";
import { POLL_INTERVALS, Poller, type Scheduler } from "../src/dashboard/page/poller.ts";
import {
  counterRate,
  DeviceTrack,
  intervalMean,
  memberRates,
  OutsideTrack,
  READINGS_PER_DEVICE,
  Tracks,
} from "../src/dashboard/page/rates.ts";
import {
  bearer,
  forgetToken,
  TOKEN_KEY,
  type TokenStorage,
  takeToken,
  tokenInFragment,
} from "../src/dashboard/page/token.ts";
import type { DeviceMetrics, RackMetrics } from "../src/metrics.ts";
import type { EventRecord, SlotStatus, UpdateRecord } from "../src/reports.ts";

// ---- Builders ----

function served(calls: number, ok: number, errors: Record<string, number>, timeMs: number) {
  return { kind: "rpc" as const, calls, ok, errors, active: 0, timeMs };
}

function called(calls: number, ok: number, errors: Record<string, number>, timeMs: number) {
  return { kind: "rpc" as const, calls, ok, errors, pending: 0, queued: 0, timeMs };
}

/** A reading of a device with one served member `kv.get` and one called member `db.query`. */
function reading(
  options: {
    firmware?: string;
    since?: number;
    servedCalls?: number;
    servedOk?: number;
    servedErrors?: Record<string, number>;
    servedTime?: number;
    madeCalls?: number;
  } = {},
): DeviceMetrics {
  const servedCalls = options.servedCalls ?? 0;
  const madeCalls = options.madeCalls ?? 0;
  return {
    device: "cache",
    firmware: options.firmware ?? "aaaa1111bbbb2222",
    since: options.since ?? 1_000,
    loop: { delayMs: 0.5, maxDelayMs: 4 },
    provides: {
      kv: {
        get: served(
          servedCalls,
          options.servedOk ?? servedCalls,
          options.servedErrors ?? {},
          options.servedTime ?? servedCalls * 2,
        ),
        changed: { kind: "event", emitted: 0, dropped: 0 },
      },
    },
    needs: {
      db: { query: called(madeCalls, madeCalls, {}, madeCalls * 5) },
    },
  };
}

function status(name: string, state: SlotStatus["state"], extra: Partial<SlotStatus> = {}) {
  return {
    name,
    model: `${name}-model`,
    u: 1,
    height: 1,
    state,
    firmware: "aaaa1111bbbb2222",
    source: `/srv/app/devices/${name}.ts`,
    inFlight: 0,
    crashes: 0,
    knownGood: "aaaa1111bbbb2222",
    watchdogs: [],
    stuck: [],
    listeners: [],
    ...extra,
  } satisfies SlotStatus;
}

function logRecord(seq: number, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    type: "log",
    level: "info",
    message: `entry ${seq}`,
    seq,
    time: 10_000 + seq,
    ...extra,
  } as EventRecord;
}

function records(from: number, to: number): EventRecord[] {
  const list: EventRecord[] = [];
  for (let seq = from; seq <= to; seq++) list.push(logRecord(seq));
  return list;
}

function update(seq: number, extra: Partial<UpdateRecord> = {}): UpdateRecord {
  return {
    seq,
    time: 50_000 + seq,
    device: "cache",
    mode: "hot",
    cause: "reload",
    from: "aaaa1111bbbb2222",
    to: "cccc3333dddd4444",
    ok: true,
    ...extra,
  };
}

/** A scheduler whose timers tick only when the test says so. */
class FakeScheduler implements Scheduler {
  readonly timers: Array<{ ms: number; tick: () => void; cancelled: boolean }> = [];

  every(ms: number, tick: () => void): () => void {
    const timer = { ms, tick, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Fires every live timer of an interval once. */
  fire(ms: number): void {
    for (const timer of this.timers) if (timer.ms === ms && !timer.cancelled) timer.tick();
  }
}

/** A promise that the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Lets every promise callback that waits run, before the next timer. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- Rates ----

describe("rates of the counters", () => {
  test("a counter's rate is its difference over the interval, and none when it went down", () => {
    expect(counterRate(10, 30, 2)).toBe(10);
    expect(counterRate(10, 10, 2)).toBe(0);
    expect(counterRate(30, 10, 2)).toBeNull();
    expect(counterRate(10, 30, 0)).toBeNull();
    expect(counterRate(10, 30, -1)).toBeNull();
  });

  test("the mean duration covers the calls that finished in the interval, not since boot", () => {
    const before = { ok: 100, errors: {}, timeMs: 100 };
    const after = { ok: 110, errors: { RACK_TIMEOUT: 2 }, timeMs: 1_300 };
    // 12 calls finished in 1,200 ms: 100 ms each, while the mean since boot is 1,300 / 112.
    expect(intervalMean(before, after)).toBe(100);
    expect(intervalMean(after, after)).toBeNull();
    // Counters that were absent count as zeros, as a member's do before its first call.
    expect(intervalMean(undefined, { ok: 4, errors: {}, timeMs: 10 })).toBe(2.5);
  });

  test("a member's rates: calls, errors, and the mean for RPC; events and drops for events", () => {
    const before = served(10, 9, { NOPE: 1 }, 50);
    const after = served(30, 25, { NOPE: 3, RACK_TIMEOUT: 2 }, 250);
    expect(memberRates(before, after, 2)).toEqual({ rate: 10, errors: 2, meanMs: 200 / 20 });
    expect(
      memberRates(
        { kind: "event", emitted: 4, dropped: 0 },
        { kind: "event", emitted: 10, dropped: 2 },
        2,
      ),
    ).toEqual({ rate: 3, errors: 1, meanMs: null });
    expect(memberRates({ kind: "event", received: 1 }, { kind: "event", received: 5 }, 4)).toEqual({
      rate: 1,
      errors: null,
      meanMs: null,
    });
  });

  test("the first reading gives no rate, and the next one of the same instance does", () => {
    const track = new DeviceTrack();
    track.add(0, reading({ servedCalls: 10, madeCalls: 4 }));
    expect(track.points).toEqual([{ time: 0, served: null, made: null, errors: null }]);
    expect(track.latest?.restarted).toBe(false);
    track.add(2_000, reading({ servedCalls: 30, madeCalls: 8 }));
    expect(track.points[1]).toEqual({ time: 2_000, served: 10, made: 2, errors: 0 });
    expect(track.latest?.provides.kv?.get).toEqual({ rate: 10, errors: 0, meanMs: 2 });
    expect(track.latest?.needs.db?.query).toEqual({ rate: 2, errors: 0, meanMs: 5 });
  });

  test("counters that restart with a new firmware or a new boot give no rate for that interval", () => {
    const track = new DeviceTrack();
    track.add(0, reading({ servedCalls: 500 }));
    track.add(2_000, reading({ servedCalls: 520 }));
    // A swap: the new instance counts from zero, so the difference would be negative.
    track.add(4_000, reading({ firmware: "ffff0000ffff0000", since: 3_500, servedCalls: 6 }));
    expect(track.latest?.restarted).toBe(true);
    expect(track.points[2]).toEqual({ time: 4_000, served: null, made: null, errors: null });
    track.add(6_000, reading({ firmware: "ffff0000ffff0000", since: 3_500, servedCalls: 26 }));
    expect(track.points[3]?.served).toBe(10);
    // A reset boots the same firmware again: only `since` changes.
    track.add(8_000, reading({ firmware: "ffff0000ffff0000", since: 7_000, servedCalls: 40 }));
    expect(track.latest?.restarted).toBe(true);
    expect(track.points[4]?.served).toBeNull();
  });

  test("errors per second add up the failed calls served and made", () => {
    const track = new DeviceTrack();
    track.add(0, reading({ servedCalls: 10, servedOk: 10 }));
    track.add(
      2_000,
      reading({ servedCalls: 20, servedOk: 14, servedErrors: { BAD: 4, RACK_TIMEOUT: 2 } }),
    );
    expect(track.points[1]?.errors).toBe(3);
  });

  test(`a device keeps at most ${READINGS_PER_DEVICE} readings, the newest`, () => {
    const track = new DeviceTrack();
    for (let i = 0; i < READINGS_PER_DEVICE + 25; i++) {
      track.add(i * 2_000, reading({ servedCalls: i * 4 }));
    }
    expect(track.points).toHaveLength(READINGS_PER_DEVICE);
    expect(track.points[0]?.time).toBe(25 * 2_000);
    expect(track.points.at(-1)?.time).toBe((READINGS_PER_DEVICE + 24) * 2_000);
    expect(track.points.at(-1)?.served).toBe(2);
  });

  test("a device that metrics() leaves out gets a gap, and its counters stay for the next rate", () => {
    const tracks = new Tracks();
    const present = ["cache"];
    tracks.take(0, [reading({ servedCalls: 0 })], present);
    tracks.take(2_000, [], present);
    const track = tracks.get("cache") as DeviceTrack;
    expect(track.missing).toBe(true);
    expect(track.points[1]).toEqual({ time: 2_000, served: null, made: null, errors: null });
    // Back after 4 s: the rate covers the whole interval since the last reading.
    tracks.take(4_000, [reading({ servedCalls: 40 })], present);
    expect(track.missing).toBe(false);
    expect(track.points[2]?.served).toBe(10);
  });

  test("a failed read of metrics() gives every device a gap", () => {
    const tracks = new Tracks();
    tracks.take(0, [reading()], ["cache"]);
    tracks.fail(2_000);
    expect(tracks.get("cache")?.missing).toBe(true);
    expect(tracks.get("cache")?.points).toHaveLength(2);
  });

  test("a device that the rack no longer has is forgotten, so what the page keeps stays bounded", () => {
    const tracks = new Tracks();
    tracks.take(0, [reading()], ["cache"]);
    tracks.take(2_000, [], []);
    expect(tracks.get("cache")).toBeUndefined();
    tracks.take(4_000, [reading()], ["cache"]);
    tracks.keep([]);
    expect(tracks.names()).toEqual([]);
  });

  test("calls from outside: rates per address and member, unrouted ones, and their total", () => {
    const outside = new OutsideTrack();
    outside.take(0, {
      ports: { "cache.kv": { get: called(10, 10, {}, 20) } },
      unrouted: 1,
    });
    expect(outside.total).toBeNull();
    expect(outside.rows[0]?.rates.rate).toBeNull();
    outside.take(2_000, {
      ports: {
        "cache.kv": { get: called(30, 28, { RACK_OVERLOADED: 2 }, 60) },
        // A port's counters start at its first call.
        "web.http": { handle: called(4, 4, {}, 8) },
      },
      unrouted: 3,
    });
    expect(outside.rows.map((row) => `${row.address} ${row.member}`)).toEqual([
      "cache.kv get",
      "web.http handle",
    ]);
    expect(outside.rows[0]?.rates).toEqual({ rate: 10, errors: 1, meanMs: 2 });
    expect(outside.rows[1]?.rates.rate).toBe(2);
    expect(outside.unrouted).toEqual({ count: 3, rate: 1 });
    expect(outside.total).toBe(13);
    // A rack that started again counts from zero: that interval gives no rate.
    outside.take(4_000, { ports: { "cache.kv": { get: called(1, 1, {}, 2) } }, unrouted: 0 });
    expect(outside.rows[0]?.rates.rate).toBeNull();
    expect(outside.total).toBeNull();
  });
});

// ---- The feed ----

describe("the feed's records", () => {
  test("the first request asks for every record, and the next ones repeat the newest held", () => {
    const feed = new Feed();
    expect(feed.request()).toEqual([]);
    expect(feed.take([], records(1, 3), 0)).toBe("added");
    expect(feed.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(feed.dropped).toBe(0);
    expect(feed.request()).toEqual([2]);
    // Only the newest held came back: nothing new.
    expect(feed.take([2], records(3, 3), 1_000)).toBe("unchanged");
    expect(feed.take([2], records(3, 5), 2_000)).toBe("added");
    expect(feed.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("records that dropped out of the rack's feed before the page read them are counted", () => {
    const feed = new Feed();
    // The page opened after the rack had dropped records 1 to 39.
    feed.take([], records(40, 42), 0);
    expect(feed.dropped).toBe(39);
    // More than 1,000 records came between two reads: the held newest, 42, is gone too.
    feed.take(feed.request(), records(50, 52), 1_000);
    expect(feed.dropped).toBe(39 + 7);
    expect(feed.records.at(-1)?.seq).toBe(52);
  });

  test(`the page keeps the newest ${FEED_LIMIT} records`, () => {
    const feed = new Feed();
    feed.take([], records(1, 700), 0);
    feed.take(feed.request(), records(700, 1_500), 1_000);
    expect(feed.records).toHaveLength(FEED_LIMIT);
    expect(feed.records[0]?.seq).toBe(501);
    expect(feed.records.at(-1)?.seq).toBe(1_500);
    // The page's own bound isn't the rack's: nothing dropped out before the page read it.
    expect(feed.dropped).toBe(0);
  });

  test("a rack that started again shows by an empty answer, and its feed is read from seq 1", () => {
    const feed = new Feed();
    feed.take([], records(1, 30), 0);
    expect(feed.take(feed.request(), [], 5_000)).toBe("restarted");
    expect(feed.records).toEqual([]);
    expect(feed.restartedAt).toBe(5_000);
    // Records of the new feed reuse the numbers of the old one: the epoch tells them apart.
    expect(feed.epoch).toBe(1);
    expect(feed.request()).toEqual([]);
    feed.take([], records(1, 2), 6_000);
    expect(feed.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(feed.dropped).toBe(0);
  });

  test("a rack that started again shows by another record under the newest seq held", () => {
    const feed = new Feed();
    feed.take([], records(1, 3), 0);
    const other = logRecord(3, { time: 99_999, message: "rack shop started" });
    expect(feed.take(feed.request(), [other, logRecord(4)], 1_000)).toBe("restarted");
    expect(feed.records).toEqual([]);
  });

  test("a record's level: a log entry's own, error for faults and failed swaps, info otherwise", () => {
    const error = { code: "RACK_DEVICE_FAULT", message: "boom" };
    expect(levelOf(logRecord(1, { level: "warn" } as Partial<EventRecord>))).toBe("warn");
    expect(
      levelOf({ type: "fault", device: "a", firmware: "f", error, reset: true, seq: 2, time: 0 }),
    ).toBe("error");
    const swap = {
      type: "swap",
      device: "a",
      action: "swap",
      mode: "hot",
      from: "f",
      to: "g",
      seq: 3,
      time: 0,
    } as const;
    expect(levelOf(swap)).toBe("info");
    expect(levelOf({ ...swap, error })).toBe("error");
    expect(
      levelOf({ type: "power", device: "a", firmware: "f", state: "on", seq: 4, time: 0 }),
    ).toBe("info");
  });

  test("the operator narrows the records to a level and a device, newest first", () => {
    const list: EventRecord[] = [
      logRecord(1, { device: "web", level: "error" } as Partial<EventRecord>),
      logRecord(2, { level: "error" } as Partial<EventRecord>),
      logRecord(3, { device: "web" } as Partial<EventRecord>),
      { type: "power", device: "web", firmware: "f", state: "on", seq: 4, time: 0 },
      logRecord(5, { device: "web", level: "error" } as Partial<EventRecord>),
    ];
    const seqs = (level: Level | null, device: string | null) =>
      filterRecords(list, { level, device }).map((record) => record.seq);
    expect(seqs(null, null)).toEqual([5, 4, 3, 2, 1]);
    expect(seqs("error", null)).toEqual([5, 2, 1]);
    expect(seqs(null, "web")).toEqual([5, 4, 3, 1]);
    expect(seqs("error", "web")).toEqual([5, 1]);
    // "" stands for the entries that the rack wrote itself, which name no device.
    expect(seqs(null, "")).toEqual([2]);
  });

  test("a record's text keeps markup as text, and escapes control characters as the log does", () => {
    const message = '<img src=x onerror="alert(1)">\u001b[31mred\nline ';
    const text = describeRecord(logRecord(1, { message, data: { html: "<b>x</b>" } }));
    // The page sets it as text: the markup shows as written, and the record keeps to its row.
    expect(text.summary).toBe('<img src=x onerror="alert(1)">\\u001b[31mred\\nline\\u2028');
    expect(text.data).toBe('{"html":"<b>x</b>"}');
    const fault = describeRecord({
      type: "fault",
      device: "cache",
      firmware: "aaaa1111bbbb2222",
      error: { code: "RACK_DEVICE_FAULT", message: "x is undefined" },
      reset: true,
      seq: 2,
      time: 0,
    });
    expect(fault.summary).toBe("cache faulted, firmware aaaa1111; the rack resets it");
    expect(fault.error).toBe("RACK_DEVICE_FAULT: x is undefined");
  });
});

// ---- The connection ----

describe("the connection and the data's age", () => {
  test("connecting, live with the data's age, down since the first failure, and live again", () => {
    const status = new Freshness();
    expect(connectionOf(status, 0)).toEqual({ state: "connecting" });
    status.ok(1_000);
    expect(connectionOf(status, 3_500)).toEqual({ state: "live", age: 2_500 });
    status.fail(4_000, { status: 502, reason: "no running rack has the base directory /srv/a" });
    status.fail(5_000, { status: 502, reason: "no running rack has the base directory /srv/a" });
    expect(connectionOf(status, 9_000)).toEqual({
      state: "down",
      since: 4_000,
      reason: "no running rack has the base directory /srv/a",
      status: 502,
      age: 8_000,
    });
    status.ok(10_000);
    expect(connectionOf(status, 10_000)).toEqual({ state: "live", age: 0 });
  });

  test("a rack that never answered is down without data", () => {
    const status = new Freshness();
    status.fail(1_000, { status: 504, reason: "the rack didn't answer within 60 s" });
    expect(connectionOf(status, 2_000)).toMatchObject({ state: "down", since: 1_000, age: null });
  });

  test("a refused token and a refused page are final", () => {
    const token = new Freshness();
    token.fail(0, { status: 401, reason: "refused" });
    expect(connectionOf(token, 0)).toEqual({ state: "unauthorized" });
    const page = new Freshness();
    page.fail(0, { status: 403, reason: "refused" });
    expect(connectionOf(page, 0)).toEqual({ state: "refused" });
    expect(isFinal({ status: 401, reason: "" })).toBe(true);
    expect(isFinal({ status: 403, reason: "" })).toBe(true);
    expect(isFinal({ status: 502, reason: "" })).toBe(false);
    expect(isFinal({ status: 503, reason: "" })).toBe(false);
  });
});

// ---- Polling ----

describe("polling", () => {
  test("each kind starts at once, then skips a tick while its request still waits", async () => {
    const scheduler = new FakeScheduler();
    const waits: Array<ReturnType<typeof deferred<void>>> = [];
    const poller = new Poller(
      [
        {
          name: "status",
          intervalMs: 1_000,
          run: () => {
            const wait = deferred<void>();
            waits.push(wait);
            return wait.promise;
          },
        },
      ],
      scheduler,
    );
    poller.start();
    expect(poller.counts("status")).toEqual({ started: 1, skipped: 0 });
    expect(poller.waiting("status")).toBe(true);
    scheduler.fire(1_000);
    scheduler.fire(1_000);
    expect(poller.counts("status")).toEqual({ started: 1, skipped: 2 });
    waits[0]?.resolve();
    await settle();
    expect(poller.waiting("status")).toBe(false);
    scheduler.fire(1_000);
    expect(poller.counts("status")).toEqual({ started: 2, skipped: 2 });
  });

  test("a request that fails doesn't stop the polling", async () => {
    const scheduler = new FakeScheduler();
    const errors: unknown[] = [];
    let runs = 0;
    const poller = new Poller(
      [
        {
          name: "history",
          intervalMs: 1_000,
          run: async () => {
            runs++;
            throw new Error("boom");
          },
        },
      ],
      scheduler,
      (_kind, error) => errors.push(error),
    );
    poller.start();
    await settle();
    scheduler.fire(1_000);
    await settle();
    expect(runs).toBe(2);
    expect(errors).toHaveLength(2);
  });

  test("stopping cancels the timers", () => {
    const scheduler = new FakeScheduler();
    let runs = 0;
    const poller = new Poller(
      [{ name: "status", intervalMs: 1_000, run: async () => void runs++ }],
      scheduler,
    );
    poller.start();
    poller.stop();
    expect(poller.running).toBe(false);
    scheduler.fire(1_000);
    expect(runs).toBe(1);
  });

  test("the page asks for status, history, and events every second, and metrics every 2 s", () => {
    expect(POLL_INTERVALS).toEqual({
      status: 1_000,
      history: 1_000,
      events: 1_000,
      metrics: 2_000,
    });
  });

  test("the page's polling feeds the model, and stops for good on a 401", async () => {
    const scheduler = new FakeScheduler();
    const asked: Array<[string, unknown[]]> = [];
    const answers: Record<string, () => Outcome> = {
      status: () => ({ kind: "value", value: [status("cache", "online")] }),
      history: () => ({ kind: "value", value: [update(1)] }),
      events: () => ({ kind: "value", value: records(1, 2) }),
      metrics: () => ({
        kind: "value",
        value: { devices: [reading()], outside: { ports: {}, unrouted: 0 } } satisfies RackMetrics,
      }),
      about: () => ({ kind: "value", value: { target: "/srv/shop" } }),
    };
    let time = 1_000;
    const model = new Model();
    const poller = startPolling(
      model,
      async (op, args) => {
        asked.push([op, args]);
        return (answers[op] as () => Outcome)();
      },
      scheduler,
      () => time,
    );
    await settle();
    expect(asked.map(([op]) => op).sort()).toEqual([
      "about",
      "events",
      "history",
      "metrics",
      "status",
    ]);
    expect(asked.find(([op]) => op === "events")?.[1]).toEqual([]);
    expect(model.status?.map((device) => device.name)).toEqual(["cache"]);
    expect(model.target).toBe("/srv/shop");
    expect(model.history).toHaveLength(1);
    expect(model.feed.records).toHaveLength(2);
    expect(model.tracks.get("cache")?.points).toHaveLength(1);
    // The next ask for events repeats the newest record held; about isn't asked again.
    asked.length = 0;
    time = 2_000;
    scheduler.fire(1_000);
    await settle();
    expect(asked.map(([op]) => op).sort()).toEqual(["events", "history", "status"]);
    expect(asked.find(([op]) => op === "events")?.[1]).toEqual([1]);
    // A dashboard started again refuses the token: the page stops asking.
    answers.status = () => ({ kind: "failed", status: 401, reason: "refused" });
    asked.length = 0;
    scheduler.fire(1_000);
    await settle();
    expect(model.final?.status).toBe(401);
    expect(poller.running).toBe(false);
    asked.length = 0;
    scheduler.fire(1_000);
    scheduler.fire(2_000);
    await settle();
    expect(asked).toEqual([]);
  });

  test("a status request that waits makes the next status tick skip, while the others go on", async () => {
    const scheduler = new FakeScheduler();
    const pending = deferred<Outcome>();
    let statusAsks = 0;
    let historyAsks = 0;
    const model = new Model();
    const poller = startPolling(
      model,
      async (op) => {
        if (op === "status") {
          statusAsks++;
          return pending.promise;
        }
        if (op === "history") historyAsks++;
        return { kind: "value", value: op === "about" ? { target: "/srv/x" } : [] };
      },
      scheduler,
      () => 0,
    );
    await settle();
    scheduler.fire(1_000);
    await settle();
    scheduler.fire(1_000);
    await settle();
    expect(statusAsks).toBe(1);
    expect(historyAsks).toBe(3);
    expect(poller.counts("status").skipped).toBe(2);
    expect(poller.counts("history").skipped).toBe(0);
    pending.resolve({ kind: "failed", status: 504, reason: "the rack didn't answer within 60 s" });
    await settle();
    scheduler.fire(1_000);
    await settle();
    expect(statusAsks).toBe(2);
    poller.stop();
  });

  test("failed reads keep the last data, and their age shows", () => {
    const model = new Model();
    model.takeStatus({ kind: "value", value: [status("cache", "online")] }, 1_000);
    model.takeStatus({ kind: "failed", status: 502, reason: "no rack answers" }, 2_000);
    expect(model.status).toHaveLength(1);
    expect(connectionOf(model.fresh.status, 6_000)).toMatchObject({
      state: "down",
      since: 2_000,
      reason: "no rack answers",
      age: 5_000,
    });
    // A failed metrics read is a gap in every chart.
    model.takeMetrics(
      { kind: "value", value: { devices: [reading()], outside: { ports: {}, unrouted: 0 } } },
      1_000,
    );
    model.takeMetrics({ kind: "failed", status: 504, reason: "late" }, 3_000);
    expect(model.tracks.get("cache")?.missing).toBe(true);
  });

  test("an answer of the wrong shape, or an error of the rack, fails the read", () => {
    const model = new Model();
    model.takeStatus({ kind: "value", value: { not: "a list" } }, 0);
    expect(model.status).toBeNull();
    expect(model.fresh.status.failure?.reason).toBe(
      "the answer to status isn't one that the rack sends",
    );
    model.takeEvents(
      [],
      { kind: "error", error: { code: "RACK_INVALID_INPUT", message: "after" } },
      0,
    );
    expect(model.fresh.events.failure?.reason).toBe("RACK_INVALID_INPUT: after");
    expect(isStatusList([{ name: "a", state: "online", u: 0, height: 1 }])).toBe(false);
    expect(isMetrics({ devices: [], outside: { ports: {}, unrouted: 0 } })).toBe(true);
    expect(isMetrics({ devices: [{ device: "a" }], outside: { ports: {}, unrouted: 0 } })).toBe(
      false,
    );
  });

  test("devices are counted by state", () => {
    const model = new Model();
    model.takeStatus(
      {
        kind: "value",
        value: [
          status("a", "online"),
          status("b", "faulted"),
          status("c", "degraded"),
          status("d", "online"),
        ],
      },
      0,
    );
    expect(model.counts()).toEqual({
      online: 2,
      swapping: 0,
      degraded: 1,
      resetting: 0,
      faulted: 1,
    });
  });
});

// ---- The client ----

describe("the client of the dashboard's API", () => {
  function client(answer: (url: string, init: FetchInit) => Promise<FetchAnswer>) {
    const sent: Array<{ url: string; init: FetchInit }> = [];
    const c = new Client({
      token: "s3cret-token",
      fetch: (url, init) => {
        sent.push({ url, init });
        return answer(url, init);
      },
      timeout: () => undefined,
    });
    return { client: c, sent };
  }

  const reply = (status: number, body: string): Promise<FetchAnswer> =>
    Promise.resolve(new Response(body, { status }));

  test("posts { args } to /api/v1/<op> with the bearer token, and no cookie", async () => {
    const { client: c, sent } = client(() => reply(200, '{"ok":true,"value":[1,2]}'));
    const outcome = await c.call("history", ["cache"]);
    expect(outcome).toEqual({ kind: "value", value: [1, 2] });
    expect(sent[0]?.url).toBe(`${API_PATH}history`);
    expect(sent[0]?.init.method).toBe("POST");
    expect(sent[0]?.init.headers.authorization).toBe("Bearer s3cret-token");
    expect(sent[0]?.init.credentials).toBe("omit");
    expect(JSON.parse(sent[0]?.init.body ?? "")).toEqual({ args: ["cache"] });
  });

  test("passes the rack's error on, with its code", async () => {
    const { client: c } = client(() =>
      reply(200, '{"ok":false,"error":{"code":"RACK_NO_ROUTE","message":"no device named x"}}'),
    );
    expect(await c.call("restart", ["x"])).toEqual({
      kind: "error",
      error: { code: "RACK_NO_ROUTE", message: "no device named x" },
    });
  });

  test("an answer that isn't the rack's fails", async () => {
    for (const body of ["not json", "null", '{"ok":"yes"}', '{"ok":false,"error":"x"}']) {
      const { client: c } = client(() => reply(200, body));
      expect(await c.call("status", [])).toMatchObject({ kind: "failed", status: 200 });
    }
  });

  test("the dashboard's failures carry their status, and its message when it sends one", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "", "the dashboard refused the page's token (401)"],
      [403, "", "the dashboard refused this page (403)"],
      [
        502,
        '{"error":"no running rack has the base directory /srv/a"}',
        "no running rack has the base directory /srv/a",
      ],
      [502, "", "no rack answers (502)"],
      [503, "", "16 requests already wait for the rack (503)"],
      [
        504,
        '{"error":"the rack didn\'t answer within 60 s"}',
        "the rack didn't answer within 60 s",
      ],
      [404, "", "the dashboard doesn't forward status (404)"],
    ];
    for (const [code, body, reason] of cases) {
      const { client: c } = client(() => reply(code, body));
      expect(await c.call("status", [])).toEqual({ kind: "failed", status: code, reason });
    }
  });

  test("a dashboard that doesn't answer, or answers too late, fails with status 0", async () => {
    const down = client(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await down.client.call("status", [])).toEqual({
      kind: "failed",
      status: 0,
      reason: "the dashboard doesn't answer; it may have stopped",
    });
    const late = client(() =>
      Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    );
    expect(await late.client.call("restart", ["a"], OPERATION_WAIT_MS)).toEqual({
      kind: "failed",
      status: 0,
      reason: "the dashboard didn't answer within 610 s",
      timedOut: true,
    });
  });

  test("the page waits longer than the dashboard's own bounds, so that the dashboard's 504 comes first", () => {
    expect(READ_WAIT_MS).toBeGreaterThan(60_000);
    expect(OPERATION_WAIT_MS).toBeGreaterThan(600_000);
  });
});

// ---- The token ----

describe("the token", () => {
  class MemoryStorage implements TokenStorage {
    readonly items = new Map<string, string>();
    getItem(key: string) {
      return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      this.items.set(key, value);
    }
    removeItem(key: string) {
      this.items.delete(key);
    }
  }

  test("comes from #token= in the fragment", () => {
    expect(tokenInFragment("#token=Ab-_9")).toBe("Ab-_9");
    expect(tokenInFragment("token=Ab-_9")).toBe("Ab-_9");
    expect(tokenInFragment("#x=1&token=a%2Bb")).toBe("a+b");
    expect(tokenInFragment("#token=a+b")).toBe("a+b");
    expect(tokenInFragment("#token=")).toBeNull();
    expect(tokenInFragment("#token=%E0%A4%A")).toBeNull();
    expect(tokenInFragment("")).toBeNull();
    expect(tokenInFragment("#tokens=x")).toBeNull();
  });

  test("moves to session storage, which the fragment of a new URL overwrites", () => {
    const storage = new MemoryStorage();
    expect(takeToken("#token=first", storage)).toEqual({ token: "first", fromFragment: true });
    expect(storage.items.get(TOKEN_KEY)).toBe("first");
    expect(TOKEN_KEY).toBe("racku-dashboard-token");
    // A reload of the tab, whose address no longer holds the fragment.
    expect(takeToken("", storage)).toEqual({ token: "first", fromFragment: false });
    expect(takeToken("#token=second", storage).token).toBe("second");
    expect(storage.items.get(TOKEN_KEY)).toBe("second");
    forgetToken(storage);
    expect(takeToken("", storage)).toEqual({ token: null, fromFragment: false });
  });

  test("a storage that throws leaves the token in memory", () => {
    const broken: TokenStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(takeToken("#token=t", broken)).toEqual({ token: "t", fromFragment: true });
    expect(takeToken("", broken)).toEqual({ token: null, fromFragment: false });
    expect(() => forgetToken(broken)).not.toThrow();
  });

  test("goes as a bearer token", () => {
    expect(bearer("t0k")).toBe("Bearer t0k");
  });
});

// ---- Operations ----

describe("operations", () => {
  const cache = status("cache", "degraded", {
    firmware: "cccc3333dddd4444",
    knownGood: "aaaa1111bbbb2222",
  });

  test("each takes the arguments that the rack handle takes", () => {
    expect(reloadOperation("/srv/shop").args).toEqual([]);
    expect(stopOperation("/srv/shop").args).toEqual([]);
    expect(swapOperation(cache).args).toEqual(["cache"]);
    expect(restartOperation(cache, true).args).toEqual(["cache"]);
    expect(restartOperation(cache, false).args).toEqual(["cache", { cascade: false }]);
    expect(
      rollbackOperation(cache, { hash: "aaaa1111bbbb2222", source: "known-good" }).args,
    ).toEqual(["cache", { to: "aaaa1111bbbb2222" }]);
  });

  test("a dialog names the device and what the operation does; Stop's names the target", () => {
    const restart = restartOperation(cache, true);
    expect(restart.title).toContain("cache");
    expect(restart.description.join(" ")).toContain("consumers reload");
    expect(restartOperation(cache, false).description.join(" ")).toContain("go on running");
    const stop = stopOperation("/srv/shop");
    expect(stop.danger).toBe(true);
    expect(stop.description.join(" ")).toContain("/srv/shop");
    expect(stop.description.join(" ")).toContain("shuts down");
    expect(stop.description.join(" ")).toContain("The dashboard can't start it again");
    expect(swapOperation(cache).description.join(" ")).toContain("/srv/app/devices/cache.ts");
  });

  test("a device rolls back to its known-good firmware, or to one that its history lists", () => {
    const history = [
      update(3, { from: "cccc3333dddd4444", to: "eeee5555ffff6666", ok: false }),
      update(2, { from: "aaaa1111bbbb2222", to: "cccc3333dddd4444" }),
      update(1, { device: "web", from: "9999", to: "8888" }),
    ];
    const targets = rollbackTargets(cache, history);
    expect(targets.map((target) => [target.hash, target.source])).toEqual([
      ["aaaa1111bbbb2222", "known-good"],
      ["eeee5555ffff6666", "history"],
    ]);
    // A device that runs its known-good firmware rolls back only to what its history lists.
    const settled = { ...cache, knownGood: "cccc3333dddd4444" };
    expect(rollbackTargets(settled, history).map((target) => target.hash)).toEqual([
      "eeee5555ffff6666",
      "aaaa1111bbbb2222",
    ]);
    expect(rollbackTargets(settled, [])).toEqual([]);
  });

  test("one operation runs at a time, and the last one's outcome stays", async () => {
    const answer = deferred<Outcome>();
    const sent: Array<[string, unknown[], number]> = [];
    const operations = new Operations(
      (op, args, waitMs) => {
        sent.push([op, args, waitMs]);
        return answer.promise;
      },
      () => 7,
    );
    const first = operations.run(restartOperation(cache, true));
    expect(operations.running?.operation.op).toBe("restart");
    expect(await operations.run(swapOperation(cache))).toBeNull();
    expect(sent).toEqual([["restart", ["cache"], OPERATION_WAIT_MS]]);
    answer.resolve({ kind: "value", value: [] });
    expect((await first)?.outcome).toEqual({ kind: "value", value: [] });
    expect(operations.running).toBeNull();
    expect(operations.last?.operation.op).toBe("restart");
  });

  test("the outcome: the devices replaced, or the error with its code", () => {
    const reload = reloadOperation("/srv/shop");
    expect(
      describeOutcome(reload, {
        kind: "value",
        value: [
          { device: "cache", from: "aaaa1111bbbb2222", to: "cccc3333dddd4444", mode: "hot" },
          {
            device: "web",
            from: "1111",
            to: "2222",
            mode: "cold",
            error: { code: "RACK_HOOK_FAILED", message: "activate threw" },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      headline: "Reload the rack: 1 of 2 devices failed",
      lines: [
        "cache: hot, aaaa1111 → cccc3333",
        "web: cold, 1111 → 2222, failed with RACK_HOOK_FAILED: activate threw",
      ],
    });
    expect(describeOutcome(reload, { kind: "value", value: [] }).headline).toBe(
      "Reload the rack: no firmware changed",
    );
    expect(
      describeOutcome(swapOperation(cache), {
        kind: "error",
        error: { code: "RACK_SWAP_REJECTED", message: "cache failed to build" },
      }),
    ).toEqual({
      ok: false,
      headline: "Swap cache failed",
      lines: ["RACK_SWAP_REJECTED: cache failed to build"],
    });
    expect(
      describeOutcome(stopOperation("/srv/shop"), { kind: "value", value: null }).headline,
    ).toBe("The rack is shutting down");
  });

  test("an operation past the dashboard's wait may still run, and the history will show it", () => {
    const text = describeOutcome(restartOperation(cache, true), {
      kind: "failed",
      status: 504,
      reason: "the rack didn't answer within 10 minutes",
    });
    expect(text.headline).toBe("Restart cache with its consumers didn't end within 10 minutes");
    expect(text.lines[0]).toBe("It may still run. The history will show its outcome.");
  });
});

// ---- Formatting ----

describe("formatting", () => {
  test("durations and ages", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(-5)).toBe("0 ms");
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(1_250)).toBe("1.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(184_000)).toBe("3 min 4 s");
    expect(formatDuration(180_000)).toBe("3 min");
    expect(formatDuration(7_500_000)).toBe("2 h 5 min");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 d 4 h");
    expect(formatAge(400)).toBe("0 s");
    expect(formatAge(1_999)).toBe("1 s");
    expect(formatAge(125_000)).toBe("2 min 5 s");
  });

  test("rates, means, counts, and sizes", () => {
    expect(formatRate(null)).toBe(MISSING);
    expect(formatRate(0)).toBe("0/s");
    expect(formatRate(0.5)).toBe("0.5/s");
    expect(formatRate(0.033)).toBe("0.03/s");
    expect(formatRate(0.001)).toBe("<0.01/s");
    expect(formatRate(1.25)).toBe("1.3/s");
    expect(formatRate(42.4)).toBe("42/s");
    expect(formatRate(1_234)).toBe("1.2K/s");
    expect(formatRate(3_400_000)).toBe("3.4M/s");
    expect(formatMean(null)).toBe(MISSING);
    expect(formatMean(0.4213)).toBe("0.42 ms");
    expect(formatMean(4.25)).toBe("4.3 ms");
    expect(formatMean(42.4)).toBe("42 ms");
    expect(formatMean(1_300)).toBe("1.3 s");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1_284)).toBe("1,284");
    expect(formatCount(12_345_678)).toBe("12,345,678");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KiB");
    expect(formatBytes(42 * 1024 * 1024)).toBe("42 MiB");
    expect(formatErrorCodes({ A: 1, RACK_TIMEOUT: 3, ZERO: 0 })).toBe("RACK_TIMEOUT 3, A 1");
  });

  test("times of day, with the date on another day", () => {
    const now = new Date(2026, 10, 24, 15, 0, 0).getTime();
    expect(formatTime(new Date(2026, 10, 24, 14, 3, 5).getTime(), now)).toBe("14:03:05");
    expect(formatTime(new Date(2026, 10, 23, 9, 8, 7).getTime(), now)).toBe("2026-11-23 09:08:07");
    expect(formatWhen(now - 12_000, now)).toBe("14:59:48, 12 s ago");
    expect(formatWhen(now + 45_000, now)).toBe("15:00:45, in 45 s");
  });

  test("hashes and data", () => {
    expect(shortHash("aaaa1111bbbb2222")).toBe("aaaa1111");
    expect(shortHash(null)).toBe(MISSING);
    expect(formatData({ a: [1, "<b>"] })).toBe('{"a":[1,"<b>"]}');
    // A string is written as JSON writes it, in quotes, and cut to the limit.
    expect(formatData("x".repeat(50), 10)).toBe(`"${"x".repeat(8)}…`);
  });

  test("text from devices and clients: markup stays, control characters are escaped", () => {
    expect(visibleText("<b>plain</b> & text")).toBe("<b>plain</b> & text");
    expect(visibleText("a\nb\tc\r\u0000\u001b[2J\u007f\u0085  ")).toBe(
      "a\\nb\\tc\\r\\u0000\\u001b[2J\\u007f\\u0085\\u2028\\u2029",
    );
    expect(errorText({ code: "BAD", message: "line 1\nfake 06:43:23 info web" })).toBe(
      "BAD: line 1\\nfake 06:43:23 info web",
    );
  });

  test("the marks of a device, and the units it takes", () => {
    expect(marksOf({}).map((mark) => mark.text)).toEqual([]);
    expect(
      marksOf({ hotplug: true, owner: "orders", packaged: true }).map((mark) => [
        mark.kind,
        mark.text,
        mark.short,
      ]),
    ).toEqual([
      ["hotplug", "hot-plug", "hot-plug"],
      ["copy", "copy for orders", "copy"],
      ["packaged", "packaged", "packaged"],
    ]);
    expect(unitsText({ u: 3, height: 1 })).toBe("U3");
    expect(unitsText({ u: 3, height: 2 })).toBe("U3–U4");
  });
});

describe("geometry of the chart and the rack's front", () => {
  test("the chart's scale tops out at a round number", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-3)).toBe(1);
    expect(niceCeiling(0.3)).toBe(0.5);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(23)).toBe(25);
    expect(niceCeiling(180)).toBe(200);
    expect(niceCeiling(4_100)).toBe(5_000);
  });

  test("a line breaks at its gaps, and keeps to the last 2 minutes", () => {
    const now = 1_000_000;
    const points = [
      { time: now - CHART_SPAN_MS - 2_000, value: 9 },
      { time: now - 6_000, value: 1 },
      { time: now - 4_000, value: 2 },
      { time: now - 2_000, value: null },
      { time: now, value: 4 },
    ];
    expect(runsOf(points, now - CHART_SPAN_MS, now)).toEqual([
      [
        { time: now - 6_000, value: 1 },
        { time: now - 4_000, value: 2 },
      ],
      [{ time: now, value: 4 }],
    ]);
    expect(nearestIndex([0, 2_000, 4_000], 2_900)).toBe(1);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  test("the front shows 42 units, or more for a device above them, top down", () => {
    const low = { ...status("a", "online"), u: 1, height: 2 };
    const high = { ...status("b", "online"), u: 44, height: 1 };
    expect(unitsOf([])).toBe(RACK_UNITS);
    expect(unitsOf([low])).toBe(42);
    expect(unitsOf([low, high])).toBe(44);
    // On a front of 42 units, U1 and U2 are the bottom two rows.
    expect(placeOf(low, 42)).toEqual({ row: 41, rows: 2 });
    expect(placeOf({ u: 42, height: 1 }, 42)).toEqual({ row: 1, rows: 1 });
    expect(emptyUnits([low], 4)).toEqual([4, 3]);
  });
});
