/**
 * Tests for the watchdog: the event-loop watchdog of every device, the watchdogs that devices
 * feed from their work loops, what a bite does, and how the watchdogs are reported.
 *
 * @decision .agents/decisions/261117_062959-watchdog.md#two-kinds-of-watchdog
 * @decision .agents/decisions/261117_062959-watchdog.md#feeding-and-checking
 * @decision .agents/decisions/261117_062959-watchdog.md#biting
 * @decision .agents/decisions/261117_062959-watchdog.md#configuration-and-observation
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type RackHandle, slot } from "rack42u";
import { crashWindow } from "../src/rack.ts";
import {
  Cli,
  errorOf,
  type TempApp,
  tempApp,
  useControlDir,
  useRacks,
  waitFor,
} from "./fixtures/app.ts";
import { type BlockingPipe, blockingPipe } from "./fixtures/pipe.ts";

const startRack = useRacks();
useControlDir();

const apps: TempApp[] = [];
const processes: Cli[] = [];
const pipes: BlockingPipe[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  for (const pipe of pipes.splice(0)) await pipe.close();
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** A pipe that blocks the thread reading it until the test releases it, or the test ends. */
async function pipeIn(created: TempApp): Promise<BlockingPipe> {
  const pipe = await blockingPipe(created.dir);
  pipes.push(pipe);
  return pipe;
}

const CONNECTORS = `import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Probe = connector("demo.probe/v1", {
  inc: rpc(v.undefined(), v.number()),
  hang: rpc(v.picklist(["busy", "microtask"]), v.number()),
  block: rpc(v.number(), v.number()),
  read: rpc(v.string(), v.string()),
  starve: rpc(v.undefined(), v.null()),
  notes: rpc(v.undefined(), v.array(v.string())),
});
`;

/**
 * A device that can hang in every way a watchdog has to catch. `activate` is the body of its
 * `activate(ctx, scope)` hook, with `starved` and `notes` in scope.
 */
function probe(options: { activate?: string; deactivate?: string; version?: string } = {}) {
  return `import { readFileSync } from "node:fs";
import { device } from "rack42u";
import { Probe } from "../connectors.ts";

const VERSION = "${options.version ?? "v1"}";
let n = 0;
let starved = false;
const notes: string[] = [];

export default device({
  model: "probe",
  provides: { probe: Probe },
  powerOn: () => ({
    probe: {
      inc: () => ++n,
      hang(kind) {
        if (kind === "busy") for (;;) {}
        const spin = (): Promise<void> => Promise.resolve().then(spin);
        void spin();
        return 0;
      },
      block(ms) {
        const until = performance.now() + ms;
        while (performance.now() < until) {}
        return ms;
      },
      read: (path) => readFileSync(path, "utf8") + VERSION,
      starve() {
        starved = true;
        return null;
      },
      notes: () => notes,
    },
  }),
  activate(ctx, scope) {
${options.activate ?? ""}
  },
  async deactivate() {
${options.deactivate ?? ""}
  },
});
`;
}

/** Feeds a 1 s watchdog named "poller" every 100 ms until `starve` is called. */
const POLLER = `    const dog = scope.watchdog(1_000, "poller");
    scope.every(100, () => {
      if (!starved) dog.feed();
    });`;

async function app(device: string): Promise<TempApp> {
  const created = await tempApp();
  apps.push(created);
  await created.write("connectors.ts", CONNECTORS);
  await created.write("devices/probe.ts", device);
  return created;
}

const RACK = { slots: { 1: slot("./devices/probe.ts") } };

/** The first device's status. */
function probeStatus(running: RackHandle) {
  const [status] = running.status();
  if (status === undefined) throw new Error("the rack has no device");
  return status;
}

async function online(running: RackHandle): Promise<void> {
  await waitFor(() => probeStatus(running).state === "online", 10_000);
}

describe("the event-loop watchdog", () => {
  // README.md, "Hangs and watchdogs".
  test("README.md: a device whose event loop stays blocked is reset, and its calls in flight fail with RACK_DEVICE_FAULT", async () => {
    const created = await app(probe());
    const { running, rec } = await startRack(RACK, { baseDir: created.dir, watchdog: 1_000 });
    await running.call("probe.probe", "inc", undefined);
    const started = performance.now();
    const error = await errorOf(running.call("probe.probe", "hang", "busy"));
    const elapsed = performance.now() - started;
    expect([error.code, error.message]).toEqual([
      "RACK_DEVICE_FAULT",
      'probe: watchdog "event loop" was not fed for 1000 ms',
    ]);
    // Between 1 and 1.25 timeouts after the last feed, which came at most 125 ms before the hang.
    expect(elapsed).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(3_000);
    await online(running);
    // A fresh instance: its count starts again.
    expect(await running.call("probe.probe", "inc", undefined)).toBe(1);
    expect(probeStatus(running)).toMatchObject({
      crashes: 1,
      error: {
        code: "RACK_DEVICE_FAULT",
        data: { watchdog: "event loop", timeout: 1000 },
      },
    });
    expect(rec.events).toContainEqual(
      expect.objectContaining({
        type: "fault",
        device: "probe",
        reset: true,
        error: expect.objectContaining({ data: { watchdog: "event loop", timeout: 1000 } }),
      }),
    );
  });

  test("README.md: an endless chain of microtasks starves the event loop, and the watchdog resets the device", async () => {
    const created = await app(probe());
    const { running } = await startRack(RACK, { baseDir: created.dir, watchdog: 1_000 });
    await running.call("probe.probe", "hang", "microtask").catch(() => undefined);
    await waitFor(() => probeStatus(running).crashes === 1, 5_000);
    await online(running);
    expect(await running.call("probe.probe", "inc", undefined)).toBe(1);
  });
});

describe("device watchdogs", () => {
  // README.md, "Hangs and watchdogs".
  test("README.md: a work loop that stops feeding its watchdog gets the device reset, with the watchdog named in the error", async () => {
    const created = await app(probe({ activate: POLLER }));
    const { running } = await startRack(RACK, { baseDir: created.dir, watchdog: 1_000 });
    await running.call("probe.probe", "inc", undefined);
    // Fed for 2 s, neither watchdog bites: the Worker host feeds the event loop's too.
    await Bun.sleep(2_000);
    expect(probeStatus(running)).toMatchObject({ state: "online", crashes: 0 });
    await running.call("probe.probe", "starve", undefined);
    await waitFor(() => probeStatus(running).crashes === 1, 5_000);
    expect(probeStatus(running).error).toEqual({
      code: "RACK_DEVICE_FAULT",
      message: 'probe: watchdog "poller" was not fed for 1000 ms',
      data: { watchdog: "poller", timeout: 1000 },
    });
    await online(running);
    // The new instance arms its own watchdog and feeds it.
    expect(await running.call("probe.probe", "inc", undefined)).toBe(1);
    await Bun.sleep(1_500);
    expect(probeStatus(running)).toMatchObject({ state: "online", crashes: 1 });
  }, 15_000);

  test("README.md: scope.watchdog takes at least 1 000 ms, arms at most 16, and numbers the unnamed ones", async () => {
    const activate = `    for (const ms of [999, Number.NaN]) {
      try {
        scope.watchdog(ms);
      } catch (error) {
        notes.push(\`\${(error as Error).name}: \${(error as Error).message}\`);
      }
    }
    const dogs = [scope.watchdog(60_000), scope.watchdog(60_000, "named"), scope.watchdog(60_000)];
    for (let i = 3; i < 16; i++) dogs.push(scope.watchdog(60_000, \`extra \${i}\`));
    try {
      scope.watchdog(60_000);
    } catch (error) {
      notes.push(\`\${(error as Error).name}: \${(error as Error).message}\`);
    }
    dogs[1]?.cancel();
    dogs.push(scope.watchdog(60_000, "after cancel"));
    scope.every(100, () => {
      for (const dog of dogs) dog.feed();
    });`;
    const created = await app(probe({ activate }));
    const { running } = await startRack(RACK, { baseDir: created.dir });
    expect(await running.call("probe.probe", "notes", undefined)).toEqual([
      "RangeError: a watchdog timeout must be at least 1000 ms, got 999",
      "RangeError: a watchdog timeout must be at least 1000 ms, got NaN",
      "RangeError: at most 16 watchdogs can be armed at once",
    ]);
    const names = probeStatus(running).watchdogs.map((watchdog) => watchdog.name);
    expect(names.slice(0, 3)).toEqual(["event loop", "watchdog 1", "watchdog 3"]);
    expect(names).not.toContain("named");
    expect(names.at(-1)).toBe("after cancel");
    expect(names).toHaveLength(17);
  });

  test("README.md: cancel() disarms a watchdog", async () => {
    const activate = `    scope.watchdog(1_000, "job").cancel();`;
    const created = await app(probe({ activate }));
    const { running } = await startRack(RACK, { baseDir: created.dir });
    await Bun.sleep(1_800);
    expect(probeStatus(running)).toMatchObject({ state: "online", crashes: 0 });
    expect(probeStatus(running).watchdogs.map((watchdog) => watchdog.name)).toEqual(["event loop"]);
  });

  test("README.md: watchdogs disarm when deactivate starts, so a slow deactivate during a swap doesn't trip them", async () => {
    // A deactivate that blocks the event loop longer than the watchdog's timeout: hookTimeout
    // bounds it, not the watchdog.
    const deactivate =
      "    const until = performance.now() + 1_600;\n    while (performance.now() < until) {}";
    const created = await app(probe({ activate: POLLER, deactivate }));
    const { running, rec } = await startRack(RACK, { baseDir: created.dir, watchdog: 1_000 });
    await created.write("devices/probe.ts", probe({ activate: POLLER, deactivate, version: "v2" }));
    const [result] = await running.reload();
    expect([result?.mode, result?.error]).toEqual(["hot", undefined]);
    expect(rec.events.filter((event) => event.type === "fault")).toEqual([]);
    expect(probeStatus(running)).toMatchObject({ state: "online", crashes: 0 });
  });
});

describe("biting", () => {
  // README.md, "Hangs and watchdogs".
  test("README.md: a device that hangs on probation falls back to its known-good firmware", async () => {
    const created = await app(probe());
    const { running } = await startRack(RACK, { baseDir: created.dir, watchdog: 1_000 });
    const good = probeStatus(running).firmware;
    const hangs = "    scope.after(50, () => {\n      for (;;) {}\n    });";
    await created.write("devices/probe.ts", probe({ activate: hangs, version: "v2" }));
    const [result] = await running.reload();
    expect(result?.error).toBeUndefined();
    // status() shows the fallback's instance as the rack installs it, and the history records
    // the fallback once the install is done, so the test waits for the record.
    await waitFor(() => running.history("probe")[0]?.cause === "fallback", 5_000);
    expect(probeStatus(running)).toMatchObject({
      state: "degraded",
      firmware: good,
      knownGood: good,
      error: { data: { watchdog: "event loop", timeout: 1000 } },
    });
    expect(running.history("probe")[0]).toMatchObject({
      cause: "fallback",
      to: good,
      error: { data: { watchdog: "event loop", timeout: 1000 } },
    });
    expect(await running.call("probe.probe", "inc", undefined)).toBe(1);
  });

  test("README.md: a device that hangs again after every reset ends up faulted", async () => {
    const hangs = "    scope.after(50, () => {\n      for (;;) {}\n    });";
    const created = await app(probe({ activate: hangs }));
    const { running, rec } = await startRack(RACK, { baseDir: created.dir, watchdog: 1_000 });
    await waitFor(() => probeStatus(running).state === "faulted", 15_000);
    const faults = rec.events.filter((event) => event.type === "fault");
    expect(faults.map((event) => event.type === "fault" && event.reset)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(probeStatus(running).crashes).toBe(4);
  }, 20_000);

  test("README.md: a Worker stuck in native code faults its slot once hookTimeout passes, and a swap brings the device back", async () => {
    const created = await app(probe());
    const pipe = await pipeIn(created);
    const { running, rec } = await startRack(RACK, {
      baseDir: created.dir,
      watchdog: 1_000,
      hookTimeout: 1_000,
    });
    // Reading a pipe that nothing writes to blocks the Worker's thread inside a system call.
    const read = running.call("probe.probe", "read", pipe.path);
    expect((await errorOf(read)).code).toBe("RACK_DEVICE_FAULT");
    expect(probeStatus(running).state).toBe("resetting");
    await waitFor(() => probeStatus(running).state === "faulted", 5_000);
    expect(rec.logs.map((entry) => entry.message)).toContainEqual(
      expect.stringContaining("its thread is stuck in native code"),
    );
    // The thread returns once the pipe is released, but the slot stays faulted.
    await pipe.release();
    await Bun.sleep(300);
    expect(probeStatus(running).state).toBe("faulted");
    await running.swap("probe");
    expect(probeStatus(running).state).toBe("online");
    expect(await running.call("probe.probe", "inc", undefined)).toBe(1);
  }, 15_000);

  test("an update stuck in native code on probation doesn't become known-good while the rack waits for it", async () => {
    const created = await app(probe());
    const pipe = await pipeIn(created);
    // Probation would end during the wait for the stuck thread: at 1.5 s, between the bite
    // after 1 to 1.25 s and the end of hookTimeout after 2 to 2.25 s.
    const { running } = await startRack(RACK, {
      baseDir: created.dir,
      watchdog: 1_000,
      hookTimeout: 1_000,
      probation: 1_500,
    });
    const good = probeStatus(running).firmware;
    const stuck = `    scope.after(50, () => readFileSync(${JSON.stringify(pipe.path)}));`;
    await created.write("devices/probe.ts", probe({ activate: stuck, version: "v2" }));
    await running.reload();
    await waitFor(() => probeStatus(running).state === "faulted", 5_000);
    expect(probeStatus(running).knownGood).toBe(good);
    await pipe.release();
  }, 15_000);

  test("README.md: the window of the crash limit is 60 s, or four times the longest watchdog timeout", () => {
    expect([crashWindow(0), crashWindow(10_000), crashWindow(15_000)]).toEqual([
      60_000, 60_000, 60_000,
    ]);
    expect(crashWindow(20_000)).toBe(80_000);
  });
});

describe("configuration and observation", () => {
  // README.md, "Hangs and watchdogs".
  test("README.md: status() lists each device's watchdogs, and metrics() its event-loop delay", async () => {
    const activate = `    const dog = scope.watchdog(5_000, "poller");
    scope.every(100, () => dog.feed());`;
    const created = await app(probe({ activate }));
    const { running } = await startRack(RACK, { baseDir: created.dir, watchdog: 2_000 });
    const before = Date.now();
    await Bun.sleep(1_500);
    const watchdogs = probeStatus(running).watchdogs;
    expect(watchdogs.map(({ name, timeout }) => [name, timeout])).toEqual([
      ["event loop", 2000],
      ["poller", 5000],
    ]);
    // The event loop's watchdog is checked every 500 ms: its last feed is recent.
    expect(watchdogs[0]?.lastFed).toBeGreaterThanOrEqual(before);
    await running.call("probe.probe", "block", 400);
    // The late tick runs after the call returns; give it the time to.
    await Bun.sleep(300);
    const [entry] = (await running.metrics()).devices;
    expect(entry?.loop.maxDelayMs).toBeGreaterThanOrEqual(100);
    expect(entry?.loop.delayMs).toBeGreaterThanOrEqual(0);
  });

  test("README.md: watchdog: 0 turns off every watchdog, and a hung device then holds its calls until they time out", async () => {
    const activate = `    scope.watchdog(1_000, "never fed");`;
    const created = await app(probe({ activate }));
    // Stopping waits for the hung device's hooks and calls: keep those waits short.
    const { running } = await startRack(RACK, {
      baseDir: created.dir,
      watchdog: 0,
      hookTimeout: 1_000,
      drainTimeout: 1_000,
    });
    const error = await errorOf(running.call("probe.probe", "hang", "busy", { timeout: 1_500 }));
    expect(error.code).toBe("RACK_TIMEOUT");
    expect(probeStatus(running)).toMatchObject({ state: "online", crashes: 0, watchdogs: [] });
  });

  test("README.md: the start option watchdog is 0 or at least 1 000 ms", async () => {
    const created = await app(probe());
    const error = await errorOf(startRack(RACK, { baseDir: created.dir, watchdog: 500 }));
    expect([error.code, error.message]).toEqual([
      "RACK_MANIFEST",
      "start option watchdog must be 0 or at least 1000 ms",
    ]);
  });

  test("README.md: rack start --no-watchdog turns off every watchdog", async () => {
    const created = await app(probe());
    await created.write(
      "rack.ts",
      'import { rack, slot } from "rack42u";\n\nexport default rack("probe", { slots: { 1: slot("./devices/probe.ts") } });\n',
    );
    const watched = new Cli(["start"], created.dir);
    processes.push(watched);
    await watched.waitFor(/control listening/);
    const on = new Cli(["ctl", "status"], created.dir);
    expect(await on.exited()).toBe(0);
    expect(JSON.parse(on.output)[0].watchdogs).toEqual([
      { name: "event loop", timeout: 10000, lastFed: expect.any(Number) },
    ]);
    const stop = new Cli(["ctl", "stop"], created.dir);
    expect(await stop.exited()).toBe(0);
    expect(await watched.exited()).toBe(0);
    const unwatched = new Cli(["start", "--no-watchdog"], created.dir);
    processes.push(unwatched);
    await unwatched.waitFor(/control listening/);
    const off = new Cli(["ctl", "status"], created.dir);
    expect(await off.exited()).toBe(0);
    expect(JSON.parse(off.output)[0].watchdogs).toEqual([]);
  });
});
