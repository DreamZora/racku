/**
 * Tests for the rack's feed of recent events: the records that `events()` returns, their order,
 * numbers, and times; the debug entries it leaves out; its bounds, 1 000 records of at most 4 096
 * characters each; details as `--log json` writes them; and the endpoint's operation `events`, on
 * the Unix socket and on TCP with its token.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type EventRecord,
  type LogEntry,
  RackError,
  type RackEvent,
  type RackHandle,
  type StartOptions,
  slot,
} from "racku";
import { type ControlFile, controlPaths } from "../src/control.ts";
import { formatLogJson } from "../src/log.ts";
import {
  CONTROL_DIR,
  errorOf,
  type TempApp,
  type TestRack,
  tempApp,
  useControlDir,
  useRacks,
  WINDOWS,
  waitFor,
} from "./fixtures/app.ts";

const startRack = useRacks();
useControlDir();

// The racks with an endpoint put it in the runtime directory that useControlDir() removes.
let savedRuntime: string | undefined;
beforeAll(() => {
  savedRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = CONTROL_DIR;
});
afterAll(() => {
  if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedRuntime;
});

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, rpc } from "racku";
import * as v from "valibot";

export const Talk = connector("test.talk/v1", {
  say: rpc(
    v.object({
      level: v.picklist(["debug", "info", "warn", "error"]),
      message: v.string(),
      times: v.optional(v.number()),
      details: v.optional(v.picklist(["bigint", "circular", "large"])),
    }),
    v.undefined(),
  ),
  crash: rpc(v.string(), v.undefined()),
});
`;

/**
 * A device that logs what a test asks it to, `times` entries numbered from 1 when given, with
 * details that JSON can't hold as they are, or that make a record too long; and that crashes with
 * a message the test gives.
 */
const TALKER = `import { device } from "racku";
import { Talk } from "../connectors.ts";

function details(kind?: string): unknown {
  if (kind === "bigint") return { count: 12345678901234567890n };
  if (kind === "circular") {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    return loop;
  }
  if (kind === "large") return { text: "x".repeat(10_000) };
  return undefined;
}

export default device({
  model: "talker",
  provides: { talk: Talk },
  powerOn: (ctx) => ({
    talk: {
      say({ level, message, times, details: kind }) {
        if (times === undefined) ctx.log[level](message, details(kind));
        else for (let n = 1; n <= times; n++) ctx.log[level](\`\${message} \${n}\`, details(kind));
      },
      crash(message) {
        setTimeout(() => {
          throw new Error(message);
        });
      },
    },
  }),
});
`;

/** The talker, with an activate that fails with a message of 6 000 characters. */
const FAILING = TALKER.replace(
  "  powerOn: (ctx) => ({",
  `  activate() {
    throw new Error("no ".repeat(2_000));
  },
  powerOn: (ctx) => ({`,
);

const SPEC = { slots: { 1: slot("./devices/talker.ts") } };

/** Starts a rack of the talker alone in an app of its own. */
async function talkerRack(
  options: StartOptions = {},
  spec: Parameters<typeof startRack>[0] = SPEC,
): Promise<TestRack & { created: TempApp }> {
  const created = await tempApp();
  apps.push(created);
  await created.write("connectors.ts", CONNECTORS);
  await created.write("devices/talker.ts", TALKER);
  await created.write("devices/failing.ts", FAILING);
  return { created, ...(await startRack(spec, { baseDir: created.dir, ...options })) };
}

interface Say {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  times?: number;
  details?: "bigint" | "circular" | "large";
}

function say(running: RackHandle, input: Say, device = "talker"): Promise<unknown> {
  return running.call(`${device}.talk`, "say", input);
}

/** The message of a log record, or `undefined` for a record of another type. */
function messageOf(record: EventRecord | undefined): string | undefined {
  return record?.type === "log" ? record.message : undefined;
}

/** Waits until the feed holds the record of the log entry whose message `matches`. */
function logRecord(
  running: RackHandle,
  matches: (message: string) => boolean,
): Promise<EventRecord> {
  return waitFor(() => running.events().find((record) => matches(messageOf(record) ?? "")));
}

/**
 * The event that a record holds: the record without its number, and without the time that the
 * rack gave it, except for a log entry, whose time is its own.
 */
function eventOf(record: EventRecord): RackEvent {
  const { seq: _seq, time, ...event } = record;
  return (record.type === "log" ? { ...event, time } : event) as RackEvent;
}

/** The code of the `RackError` that `read` throws. */
function thrownCode(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    if (error instanceof RackError) return error.code;
    throw error;
  }
  throw new Error("expected a throw");
}

/** The length of a record as the JSON text that the feed keeps. */
function length(record: EventRecord | undefined): number {
  return JSON.stringify(record).length;
}

// @doc docs/reference/reports.md#events
// @doc docs/reference/api.md#the-rack-handle
describe("the records", () => {
  test("the feed keeps what subscribe() delivers, in order, numbered from 1, with the time the rack emitted it", async () => {
    const before = Date.now();
    const { running, rec } = await talkerRack({ faultInjection: true });
    const started = running.events();
    expect(started.map((record) => record.seq)).toEqual(started.map((_, index) => index + 1));
    expect(started).toContainEqual(
      expect.objectContaining({ type: "power", device: "talker", state: "on" }),
    );

    const debug = (event: RackEvent) => event.type === "log" && event.level === "debug";
    const delivered: RackEvent[] = [];
    // What a listener finds in the feed as each event arrives: the event's own record.
    const found: (EventRecord | undefined)[] = [];
    running.subscribe((event) => {
      delivered.push(event);
      if (!debug(event)) found.push(running.events().at(-1));
    });
    const from = started.length;
    await say(running, { level: "debug", message: "hidden" });
    await say(running, { level: "info", message: "shown" });
    await running.swap("talker");
    await running.injectFault("talker", "crash");
    // The reset after the crash powers the device on, as the swap did.
    await waitFor(
      () =>
        rec.events.filter((event) => event.type === "power" && event.state === "on").length === 2,
    );

    const records = running.events(from);
    expect(records.map((record) => record.seq)).toEqual(
      records.map((_, index) => from + 1 + index),
    );
    expect(new Set(records.map((record) => record.type))).toEqual(
      new Set(["power", "swap", "fault", "log"]),
    );
    // Everything that subscribe() delivered, apart from the debug entry, which only it got.
    expect(delivered.filter(debug).map((event) => event.type === "log" && event.message)).toEqual([
      "hidden",
    ]);
    expect(records.map(eventOf)).toEqual(delivered.filter((event) => !debug(event)));
    expect(found).toEqual(records);

    const times = [...started, ...records].map((record) => record.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThanOrEqual(before);
    expect(times.at(-1)).toBeLessThanOrEqual(Date.now());
    // A log entry keeps its own time, the one the logger got.
    const shown = records.find((record) => messageOf(record) === "shown");
    expect(shown?.time).toBe(rec.logs.find((entry) => entry.message === "shown")?.time);
  });

  test("debug entries stay out of the feed, so that a device's debugging pushes no record out", async () => {
    const { running, rec } = await talkerRack();
    const newest = running.events().at(-1)?.seq ?? 0;
    await say(running, { level: "debug", message: "tick", times: 2_000 });
    await waitFor(() => rec.logs.filter((entry) => entry.level === "debug").length === 2_000);
    expect(running.events().at(-1)?.seq).toBe(newest);
    await say(running, { level: "info", message: "after the ticks" });
    await logRecord(running, (message) => message === "after the ticks");
    expect(running.events(newest)).toEqual([
      expect.objectContaining({ seq: newest + 1, type: "log", message: "after the ticks" }),
    ]);
  });

  test("details are kept as --log json writes them: a bigint as a string ending in n, and circular ones as their String()", async () => {
    const { running, rec } = await talkerRack();
    await say(running, { level: "info", message: "a big number", details: "bigint" });
    await say(running, { level: "warn", message: "a loop", details: "circular" });
    const big = await logRecord(running, (message) => message === "a big number");
    const loop = await logRecord(running, (message) => message === "a loop");
    expect(eventOf(big)).toEqual({
      type: "log",
      time: big.time,
      level: "info",
      device: "talker",
      message: "a big number",
      data: { count: "12345678901234567890n" },
    });
    expect(eventOf(loop)).toEqual({
      type: "log",
      time: loop.time,
      level: "warn",
      device: "talker",
      message: "a loop",
      data: "[object Object]",
    });
    for (const record of [big, loop]) {
      const entry = rec.logs.find((logged) => logged.message === messageOf(record)) as LogEntry;
      const written = JSON.parse(formatLogJson(entry)) as { data: unknown };
      expect(record.type === "log" && record.data).toEqual(written.data);
    }
  });
});

// @doc docs/reference/reports.md#events
describe("the bounds", () => {
  test("the feed keeps the last 1 000 records, and a reader sees how many dropped out after the seq it read", async () => {
    const { running } = await talkerRack();
    const read = running.events().at(-1)?.seq ?? 0;
    await say(running, { level: "info", message: "entry", times: 1_100 });
    await logRecord(running, (message) => message === "entry 1100");
    const records = running.events();
    const newest = records.at(-1)?.seq ?? 0;
    expect(records).toHaveLength(1_000);
    expect(records.map((record) => record.seq)).toEqual(
      records.map((_, index) => newest - 999 + index),
    );
    expect(messageOf(records.at(-1))).toBe("entry 1100");

    // The records after `read` that the rack still keeps: the first is more than one past it.
    const after = running.events(read);
    expect(after).toEqual(records);
    const dropped = (after[0]?.seq ?? 0) - read - 1;
    expect(dropped).toBe(newest - read - 1_000);
    expect(dropped).toBeGreaterThan(0);

    expect(running.events(newest - 3).map((record) => record.seq)).toEqual([
      newest - 2,
      newest - 1,
      newest,
    ]);
    expect(running.events(newest)).toEqual([]);
    expect(running.events(newest + 100)).toEqual([]);
  });

  test("a record over 4 096 characters as JSON loses its data and has its message cut to 1 024 characters, with cut: true", async () => {
    const { running } = await talkerRack();
    const message = `long ${"m".repeat(9_000)}`;
    await say(running, { level: "error", message, details: "large" });
    const record = await logRecord(running, (text) => text.startsWith("long "));
    expect(eventOf(record)).toEqual({
      type: "log",
      time: record.time,
      level: "error",
      device: "talker",
      message: `${message.slice(0, 1_023)}…`,
      cut: true,
    } as RackEvent);
    expect(messageOf(record)).toHaveLength(1_024);
    expect(length(record)).toBeLessThanOrEqual(4_096);

    // A record that fits stays whole, its details included, and has no cut.
    const short = `short ${"s".repeat(1_500)}`;
    await say(running, { level: "info", message: short, details: "bigint" });
    const whole = await logRecord(running, (text) => text.startsWith("short "));
    expect(whole).toMatchObject({ message: short, data: { count: "12345678901234567890n" } });
    expect("cut" in whole).toBe(false);
  });

  test("a failed swap's and a crash's errors lose their data and have their messages cut", async () => {
    const { running } = await talkerRack();
    const failed = await errorOf(running.swap("talker", "./devices/failing.ts"));
    expect(failed.code).toBe("RACK_HOOK_FAILED");
    expect(failed.data).toBeDefined();
    const swap = running.events().findLast((record) => record.type === "swap");
    expect(swap).toMatchObject({
      type: "swap",
      device: "talker",
      action: "swap",
      error: { code: "RACK_HOOK_FAILED", message: `${failed.message.slice(0, 1_023)}…` },
      cut: true,
    });
    expect(swap?.type === "swap" && "data" in (swap.error ?? {})).toBe(false);
    expect(length(swap)).toBeLessThanOrEqual(4_096);

    await running.call("talker.talk", "crash", `boom ${"b".repeat(6_000)}`);
    const fault = await waitFor(() => running.events().find((record) => record.type === "fault"));
    expect(fault).toMatchObject({ type: "fault", device: "talker", cut: true });
    const crash = fault.type === "fault" ? fault.error : undefined;
    expect(crash?.code).toBe("RACK_DEVICE_FAULT");
    expect(crash?.message).toHaveLength(1_024);
    expect(crash?.message.endsWith("…")).toBe(true);
    expect(crash?.message).toContain("boom bbb");
    expect(length(fault)).toBeLessThanOrEqual(4_096);
  });

  test("a record that is still too long once cut, as when its message is full of characters that JSON escapes, has its texts cut shorter until it fits", async () => {
    const { running } = await talkerRack();
    // Each takes six characters in JSON, so 1 024 of them would still be too long.
    const escaped = `\u0001${"\u0002".repeat(3_000)}`;
    await say(running, { level: "info", message: escaped });
    const record = await logRecord(running, (message) => message.startsWith("\u0001"));
    const message = messageOf(record) ?? "";
    expect(record).toMatchObject({ cut: true });
    expect(message.length).toBeLessThan(1_024);
    expect(message).toBe(`${escaped.slice(0, message.length - 1)}…`);
    expect(length(record)).toBeLessThanOrEqual(4_096);
  });

  test("a device's name thousands of characters long is cut too, so that its records fit", async () => {
    const name = `t${"x".repeat(4_999)}`;
    const { running } = await talkerRack(
      {},
      { slots: { 1: slot("./devices/talker.ts", { name }) } },
    );
    expect(running.status()[0]?.name).toBe(name);
    const power = running.events().find((record) => record.type === "power");
    expect(power).toMatchObject({ type: "power", state: "on", cut: true });
    const device = power?.type === "power" ? power.device : "";
    expect(device.length).toBeLessThan(1_024);
    expect(device).toBe(`${name.slice(0, device.length - 1)}…`);
    expect(length(power)).toBeLessThanOrEqual(4_096);
    // Its log entries keep their messages whole while they fit.
    await say(running, { level: "info", message: "hello" }, name);
    expect(await logRecord(running, (message) => message === "hello")).toMatchObject({
      message: "hello",
      cut: true,
    });
  });

  test("a failed rollback whose to runs to thousands of characters, or is an object, leaves records within 4 096 characters, with that to cut", async () => {
    const { running } = await talkerRack();
    const read = running.events().at(-1)?.seq ?? 0;
    const long = "f".repeat(60_000);
    // Only the type of rollback() keeps code from giving an object, and the endpoint passes on
    // what a request's JSON holds.
    const object = { hash: long } as unknown as string;
    for (const to of [long, object]) {
      expect((await errorOf(running.rollback("talker", { to }))).code).toBe("RACK_SWAP_REJECTED");
    }
    const records = running.events(read);
    for (const record of records) expect(length(record)).toBeLessThanOrEqual(4_096);
    const swaps = records.filter((record) => record.type === "swap");
    expect(swaps.map((record) => record.cut)).toEqual([true, true]);
    const [text, named] = swaps.map((record) => record.to);
    expect(text?.length).toBeLessThan(1_024);
    expect(text).toBe(`${long.slice(0, (text?.length ?? 0) - 1)}…`);
    // A to that isn't a string becomes its String().
    expect(named).toBe("[object Object]");
  });

  test("on a device whose name runs to thousands of characters, a rollback to a number or to a circular object leaves records within 4 096 characters: the number as its String(), and the other record at its minimum", async () => {
    const name = `t${"x".repeat(4_999)}`;
    const { running } = await talkerRack(
      {},
      { slots: { 1: slot("./devices/talker.ts", { name }) } },
    );
    const read = running.events().at(-1)?.seq ?? 0;
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    for (const to of [12_345, loop]) {
      const error = await errorOf(running.rollback(name, { to: to as unknown as string }));
      expect(error.code).toBe("RACK_SWAP_REJECTED");
    }
    const records = running.events(read);
    for (const record of records) expect(length(record)).toBeLessThanOrEqual(4_096);
    const swaps: EventRecord[] = records.filter((record) => record.type === "swap");
    const [number, circular] = swaps;
    // The name makes the first record too long, and the cut writes its to as text.
    expect(number).toMatchObject({ type: "swap", to: "12345", cut: true });
    // JSON can't write the second, which keeps only its seq, time, type, and device's name, cut.
    const device = circular?.device ?? "";
    expect(device.length).toBeLessThan(1_024);
    expect(device).toBe(`${name.slice(0, device.length - 1)}…`);
    expect(circular).toEqual({
      seq: circular?.seq,
      time: circular?.time,
      type: "swap",
      device,
      cut: true,
    } as EventRecord);
  });
});

// @doc docs/reference/reports.md#events
describe("reading the feed", () => {
  test("an after that isn't a whole number of 0 or more fails with RACK_INVALID_INPUT", async () => {
    const { running } = await talkerRack();
    for (const after of [-1, 1.5, "x", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(thrownCode(() => running.events(after as number))).toBe("RACK_INVALID_INPUT");
    }
    expect(running.events(0)).toEqual(running.events());
    expect(running.events(undefined)).toEqual(running.events());
  });

  test("events() still answers after stop(), and a new start begins an empty feed from seq 1", async () => {
    const { created, running } = await talkerRack();
    await say(running, { level: "info", message: "before the stop" });
    await logRecord(running, (message) => message === "before the stop");
    await running.stop();
    const kept = running.events();
    expect(kept.map(messageOf)).toContain("before the stop");
    expect(kept).toContainEqual(
      expect.objectContaining({ type: "power", device: "talker", state: "off" }),
    );
    expect(messageOf(kept.at(-1))).toBe("rack test stopped");

    const { running: again } = await startRack(SPEC, { baseDir: created.dir });
    const fresh = again.events();
    expect(fresh[0]?.seq).toBe(1);
    expect(fresh.map(messageOf)).not.toContain("before the stop");
  });

  test("an event whose record JSON can't write, as of a rollback to a circular object, still reaches subscribers, and is kept at its minimum, with no gap in the seqs", async () => {
    const { running, rec } = await talkerRack();
    const read = running.events().at(-1)?.seq ?? 0;
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    // The rollback fails with the rack's own code, not with the TypeError of JSON for the loop.
    const error = await errorOf(running.rollback("talker", { to: loop as unknown as string }));
    expect(error.code).toBe("RACK_SWAP_REJECTED");
    expect(
      rec.events.some((event) => event.type === "swap" && (event.to as unknown) === loop),
    ).toBe(true);
    // The failure's log entry, which follows the swap event, is written and kept.
    const failed = "swap of talker failed: firmware [object Object] of talker is no longer kept";
    expect(rec.logs.map((entry) => entry.message)).toContain(failed);
    await say(running, { level: "info", message: "after the loop" });
    await logRecord(running, (message) => message === "after the loop");

    const records = running.events();
    expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index + 1));
    const newest = records.at(-1)?.seq ?? 0;
    for (let after = 0; after <= newest + 1; after++) {
      expect(running.events(after)).toEqual(records.filter((record) => record.seq > after));
    }
    const swap = records.find((record) => record.seq > read && record.type === "swap");
    expect(swap).toEqual({
      seq: swap?.seq,
      time: swap?.time,
      type: "swap",
      device: "talker",
      cut: true,
    } as EventRecord);
    expect(messageOf(records.find((record) => record.seq === (swap?.seq ?? 0) + 1))).toBe(failed);
  });
});

/**
 * Checks the operation `events` of an endpoint that `post` reaches with a request's body: with
 * and without `after`, with too many arguments, and with an `after` the rack refuses.
 */
async function checkOperation(
  running: RackHandle,
  post: (body: unknown) => Promise<Response>,
): Promise<void> {
  await say(running, { level: "info", message: "through the endpoint" });
  await logRecord(running, (message) => message === "through the endpoint");
  const all = running.events();
  expect(await (await post({ args: [] })).json()).toEqual({ ok: true, value: all });
  expect(await (await post({})).json()).toEqual({ ok: true, value: all });
  const newest = all.at(-1)?.seq ?? 0;
  expect(await (await post({ args: [newest - 2] })).json()).toEqual({
    ok: true,
    value: all.slice(-2),
  });
  expect((await post({ args: [1, 2] })).status).toBe(400);
  expect(await (await post({ args: ["x"] })).json()).toEqual({
    ok: false,
    error: {
      code: "RACK_INVALID_INPUT",
      message: "events: after must be a whole number, 0 or more",
    },
  });
}

// @doc docs/reference/reports.md#events
describe("the operation events", () => {
  test.skipIf(WINDOWS)("the Unix socket serves the feed", async () => {
    const { created, running } = await talkerRack({ control: true });
    const socket = controlPaths(created.dir).socket;
    await checkOperation(running, (body) =>
      fetch("http://localhost/v1/events", {
        method: "POST",
        unix: socket,
        body: JSON.stringify(body),
      }),
    );
  });

  test("the TCP endpoint serves the feed with its token", async () => {
    const { created, running } = await talkerRack({ control: { port: 0 } });
    const { url, token } = (await Bun.file(controlPaths(created.dir).file).json()) as ControlFile;
    const post = (body: unknown, headers: Record<string, string>) =>
      fetch(`${url}/v1/events`, { method: "POST", headers, body: JSON.stringify(body) });
    await checkOperation(running, (body) => post(body, { authorization: `Bearer ${token}` }));
    expect((await post({ args: [] }, {})).status).toBe(401);
  });
});
