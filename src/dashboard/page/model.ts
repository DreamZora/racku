/**
 * What the page knows of the rack: the last answers to `status`, `metrics`, `history`, `events`,
 * and `about`, how fresh each is, and the rates and records that it derives from them; and the
 * polling that asks for them. This module uses no API of the DOM or of Bun, so that tests run it
 * in Bun with a fake `fetch` and fake timers.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
 */
import type { DeviceMetrics, RackMetrics } from "../../metrics.ts";
import type { EventRecord, SlotState, SlotStatus, UpdateRecord } from "../../reports.ts";
import type { Outcome } from "./api.ts";
import { type Failure, Freshness, isFinal } from "./connection.ts";
import { Feed } from "./feed.ts";
import { errorText } from "./format.ts";
import { POLL_INTERVALS, Poller, type PollKind, type Scheduler } from "./poller.ts";
import { OutsideTrack, Tracks } from "./rates.ts";

/** The kinds of reads that the page polls. */
export type ReadKind = "status" | "metrics" | "history" | "events" | "about";

/** The states of a slot, from the best to the worst, in the order the page lists them. */
export const SLOT_STATES: readonly SlotState[] = [
  "online",
  "swapping",
  "degraded",
  "resetting",
  "faulted",
];

/** What `about` answers: what the dashboard watches. */
export interface About {
  /** The rack's base directory, or the URL of its endpoint. */
  target: string;
}

/** What the page knows of the rack. */
export class Model {
  /** The last answer to `status`, bottom slot first; `null` before one came. */
  status: SlotStatus[] | null = null;
  /** The last answer to `history`, newest first; `null` before one came. */
  history: UpdateRecord[] | null = null;
  /** What the dashboard watches, from `about`; `null` before it answered. */
  target: string | null = null;
  /** The records of the feed. */
  readonly feed = new Feed();
  /** The devices' readings of `metrics()`. */
  readonly tracks = new Tracks();
  /** The readings of the calls from outside the rack. */
  readonly outside = new OutsideTrack();
  /** How fresh each kind of data is. */
  readonly fresh: Record<ReadKind, Freshness> = {
    status: new Freshness(),
    metrics: new Freshness(),
    history: new Freshness(),
    events: new Freshness(),
    about: new Freshness(),
  };
  /** Grows by one with every answer of each kind, so that the page knows what to draw again. */
  readonly versions: Record<ReadKind, number> = {
    status: 0,
    metrics: 0,
    history: 0,
    events: 0,
    about: 0,
  };
  /**
   * The failure that ended the polling: the dashboard refused the page's token, or the page
   * itself; `null` while none did.
   */
  final: Failure | null = null;

  /**
   * Takes the answer to `status`.
   *
   * @param outcome How the request ended.
   * @param time When it ended, a millisecond timestamp of the page's clock.
   */
  takeStatus(outcome: Outcome, time: number): void {
    this.#settle("status", outcome, time, isStatusList, (status) => {
      this.status = status;
      this.tracks.keep(status.map((device) => device.name));
    });
  }

  /**
   * Takes the answer to `metrics`.
   *
   * @param outcome How the request ended.
   * @param time When it ended, a millisecond timestamp of the page's clock.
   */
  takeMetrics(outcome: Outcome, time: number): void {
    const ok = this.#settle("metrics", outcome, time, isMetrics, (metrics) => {
      const present = this.status === null ? null : this.status.map((device) => device.name);
      this.tracks.take(time, metrics.devices, present);
      this.outside.take(time, metrics.outside);
    });
    if (!ok) this.tracks.fail(time);
  }

  /**
   * Takes the answer to `history`.
   *
   * @param outcome How the request ended.
   * @param time When it ended, a millisecond timestamp of the page's clock.
   */
  takeHistory(outcome: Outcome, time: number): void {
    this.#settle("history", outcome, time, isHistory, (history) => {
      this.history = history;
    });
  }

  /**
   * Takes the answer to `events`.
   *
   * @param asked The arguments that the request carried, which `feed.request()` gave.
   * @param outcome How the request ended.
   * @param time When it ended, a millisecond timestamp of the page's clock.
   */
  takeEvents(asked: readonly number[], outcome: Outcome, time: number): void {
    this.#settle("events", outcome, time, isEventList, (records) => {
      this.feed.take(asked, records, time);
    });
  }

  /**
   * Takes the answer to the dashboard's own `about`.
   *
   * @param outcome How the request ended.
   * @param time When it ended, a millisecond timestamp of the page's clock.
   */
  takeAbout(outcome: Outcome, time: number): void {
    this.#settle("about", outcome, time, isAbout, (about) => {
      this.target = about.target;
    });
  }

  /**
   * How many devices are in each state, from the last answer to `status`.
   *
   * @returns The counts, 0 for a state that no device is in.
   */
  counts(): Record<SlotState, number> {
    const counts: Record<SlotState, number> = {
      online: 0,
      swapping: 0,
      degraded: 0,
      resetting: 0,
      faulted: 0,
    };
    for (const device of this.status ?? []) {
      if (Object.hasOwn(counts, device.state)) counts[device.state]++;
    }
    return counts;
  }

  /**
   * A device of the last answer to `status`.
   *
   * @param name The device.
   * @returns Its status, or `undefined` when the rack doesn't report it.
   */
  device(name: string): SlotStatus | undefined {
    return this.status?.find((device) => device.name === name);
  }

  /** Records an outcome; returns whether it brought data, which `apply` then took. */
  #settle<T>(
    kind: ReadKind,
    outcome: Outcome,
    time: number,
    valid: (value: unknown) => value is T,
    apply: (value: T) => void,
  ): boolean {
    this.versions[kind]++;
    let failure: Failure;
    if (outcome.kind === "value") {
      if (valid(outcome.value)) {
        apply(outcome.value);
        this.fresh[kind].ok(time);
        return true;
      }
      failure = { status: 200, reason: `the answer to ${kind} isn't one that the rack sends` };
    } else if (outcome.kind === "error") {
      failure = { status: 200, reason: errorText(outcome.error) };
    } else {
      failure = { status: outcome.status, reason: outcome.reason };
    }
    this.fresh[kind].fail(time, failure);
    if (isFinal(failure) && this.final === null) this.final = failure;
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a value has the shape of an answer to `status`, as far as the page relies on it.
 *
 * @param value The value of the answer.
 */
export function isStatusList(value: unknown): value is SlotStatus[] {
  return (
    Array.isArray(value) &&
    value.every(
      (device) =>
        isObject(device) &&
        typeof device.name === "string" &&
        typeof device.state === "string" &&
        Number.isSafeInteger(device.u) &&
        Number.isSafeInteger(device.height) &&
        (device.u as number) >= 1 &&
        (device.height as number) >= 1,
    )
  );
}

/**
 * Whether a value has the shape of an answer to `metrics`, as far as the page relies on it.
 *
 * @param value The value of the answer.
 */
export function isMetrics(value: unknown): value is RackMetrics {
  if (!isObject(value) || !Array.isArray(value.devices) || !isObject(value.outside)) return false;
  const outside = value.outside;
  return (
    isObject(outside.ports) &&
    Object.values(outside.ports).every(isObject) &&
    typeof outside.unrouted === "number" &&
    value.devices.every(isDeviceMetrics)
  );
}

function isDeviceMetrics(value: unknown): value is DeviceMetrics {
  return (
    isObject(value) &&
    typeof value.device === "string" &&
    typeof value.firmware === "string" &&
    typeof value.since === "number" &&
    isObject(value.provides) &&
    Object.values(value.provides).every(isObject) &&
    isObject(value.needs) &&
    Object.values(value.needs).every(isObject)
  );
}

/**
 * Whether a value has the shape of an answer to `history`, as far as the page relies on it.
 *
 * @param value The value of the answer.
 */
export function isHistory(value: unknown): value is UpdateRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (record) =>
        isObject(record) &&
        typeof record.seq === "number" &&
        typeof record.time === "number" &&
        typeof record.device === "string",
    )
  );
}

/**
 * Whether a value has the shape of an answer to `events`, as far as the page relies on it.
 *
 * @param value The value of the answer.
 */
export function isEventList(value: unknown): value is EventRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (record) =>
        isObject(record) &&
        Number.isSafeInteger(record.seq) &&
        typeof record.time === "number" &&
        typeof record.type === "string",
    )
  );
}

/**
 * Whether a value has the shape of an answer to `about`.
 *
 * @param value The value of the answer.
 */
export function isAbout(value: unknown): value is About {
  return isObject(value) && typeof value.target === "string";
}

/** What the page's polling sends its requests with: its client's `call`. */
export type Ask = (op: string, args: unknown[]) => Promise<Outcome>;

/**
 * The kinds of requests that the page repeats: `status`, `history`, and `events` every second,
 * `metrics` every 2 s, and `about` every second until it answered once.
 *
 * @param model What takes the answers.
 * @param ask Sends a request.
 * @param now The clock, in milliseconds.
 * @param changed Called after each answer was taken.
 * @returns The kinds, for a {@link Poller}.
 */
export function pollKinds(
  model: Model,
  ask: Ask,
  now: () => number,
  changed: () => void = () => {},
): PollKind[] {
  const kind = (name: ReadKind, intervalMs: number, run: () => Promise<void>): PollKind => ({
    name,
    intervalMs,
    run: async () => {
      await run();
      changed();
    },
  });
  return [
    kind("status", POLL_INTERVALS.status, async () => {
      model.takeStatus(await ask("status", []), now());
    }),
    kind("history", POLL_INTERVALS.history, async () => {
      model.takeHistory(await ask("history", []), now());
    }),
    kind("events", POLL_INTERVALS.events, async () => {
      const asked = model.feed.request();
      model.takeEvents(asked, await ask("events", asked), now());
    }),
    kind("metrics", POLL_INTERVALS.metrics, async () => {
      model.takeMetrics(await ask("metrics", []), now());
    }),
    kind("about", POLL_INTERVALS.status, async () => {
      // What the dashboard watches doesn't change while it runs.
      if (model.target === null) model.takeAbout(await ask("about", []), now());
    }),
  ];
}

/**
 * Starts the page's polling. It stops by itself when the dashboard refuses the page's token or
 * the page, since asking again can't change that.
 *
 * @param model What takes the answers.
 * @param ask Sends a request.
 * @param scheduler The timers.
 * @param now The clock, in milliseconds.
 * @param changed Called after each answer was taken.
 * @returns The poller, which runs.
 */
export function startPolling(
  model: Model,
  ask: Ask,
  scheduler: Scheduler,
  now: () => number,
  changed: () => void = () => {},
): Poller {
  const poller: Poller = new Poller(
    pollKinds(model, ask, now, () => {
      if (model.final !== null) poller.stop();
      changed();
    }),
    scheduler,
  );
  poller.start();
  return poller;
}
