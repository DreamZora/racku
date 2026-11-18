/**
 * Tests for ending instances: every stop waits for the Worker's thread, a thread stuck in native
 * code keeps its device from starting again, and a failed hot swap reactivates or resets the old
 * instance.
 *
 * @decision .agents/decisions/261117_185131-ending-instances.md#ending-an-instance
 * @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
 * @decision .agents/decisions/261117_185131-ending-instances.md#failed-hot-swaps
 * @decision .agents/decisions/261117_185131-ending-instances.md#inspecting-firmware
 * @decision .agents/decisions/261117_185131-ending-instances.md#observation
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type RackHandle, type SlotStatus, type StartOptions, slot } from "rack42u";
import { errorOf, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";
import { type BlockingPipe, blockingPipe } from "./fixtures/pipe.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
const pipes = new Map<string, BlockingPipe>();
afterEach(async () => {
  for (const pipe of pipes.values()) await pipe.close();
  pipes.clear();
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Jam = connector("demo.jam/v1", {
  inc: rpc(v.undefined(), v.number()),
  read: rpc(v.string(), v.string()),
  spin: rpc(v.undefined(), v.null()),
  crash: rpc(v.undefined(), v.null()),
  version: rpc(v.undefined(), v.string()),
});
`;

interface JamOptions {
  version?: string;
  swap?: "hot" | "cold";
  /** Code at the top level of the module, which runs whenever the firmware loads. */
  top?: string;
  /** Code at the start of `powerOn`. */
  powerOn?: string;
  /** The body of `deactivate`. */
  deactivate?: string;
}

/**
 * A device that blocks in native code, reading a pipe that nothing writes to, or hangs in
 * JavaScript, and that appends the time of each `powerOn` to `power.log`.
 */
function jam(app: TempApp, options: JamOptions = {}): string {
  return `import { appendFileSync, readFileSync } from "node:fs";
import { device } from "rack42u";
import { Jam } from "../connectors.ts";

const VERSION = ${JSON.stringify(options.version ?? "v1")};
${options.top ?? ""}
let n = 0;

export default device({
  model: "jam",
  swap: ${JSON.stringify(options.swap ?? "hot")},
  provides: { jam: Jam },
  async powerOn() {
    ${options.powerOn ?? ""}
    appendFileSync(${JSON.stringify(join(app.dir, "power.log"))}, \`\${VERSION} \${Date.now()}\\n\`);
    return {
      jam: {
        inc: () => ++n,
        // Reading a pipe that nothing writes to blocks the Worker's thread inside a system call.
        read: (path) => readFileSync(path, "utf8"),
        spin() {
          for (;;) {}
        },
        crash() {
          process.exit(3);
        },
        version: () => VERSION,
      },
    };
  },
  async deactivate() {
    ${options.deactivate ?? ""}
  },
});
`;
}

async function app(options: JamOptions = {}): Promise<TempApp> {
  const created = await tempApp();
  apps.push(created);
  await created.write("connectors.ts", CONNECTORS);
  await created.write("devices/jam.ts", jam(created, options));
  return created;
}

const RACK = { slots: { 1: slot("./devices/jam.ts") } };

function options(created: TempApp, more: StartOptions = {}): StartOptions {
  return { baseDir: created.dir, hookTimeout: 1_000, drainTimeout: 500, ...more };
}

/** Creates a pipe for the app, which the tests release after each test, and returns its path. */
async function pipeIn(created: TempApp): Promise<string> {
  const pipe = await blockingPipe(created.dir);
  pipes.set(pipe.path, pipe);
  return pipe.path;
}

/**
 * Lets every thread blocked on the pipe at `path` go on.
 *
 * @returns Whether a thread was blocked on it.
 */
function release(path: string): Promise<boolean> {
  const pipe = pipes.get(path);
  if (pipe === undefined) throw new Error(`no pipe at ${path}`);
  return pipe.release();
}

/** The versions and times of the device's `powerOn` runs, in order. */
async function powerOns(created: TempApp): Promise<{ version: string; time: number }[]> {
  const text = await created.read("power.log");
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const [version = "", time = ""] = line.split(" ");
      return { version, time: Number(time) };
    });
}

function jamStatus(running: RackHandle): SlotStatus {
  const [status] = running.status();
  if (status === undefined) throw new Error("the rack has no device");
  return status;
}

/**
 * The start of a `powerOn` that leaves `marker` behind, then fails 3 s later: long enough for
 * a watchdog of 1 s to bite the old instance in the meantime.
 */
function failing(marker: string): string {
  return `appendFileSync(${JSON.stringify(marker)}, "");
    await Bun.sleep(3_000);
    throw new Error("powerOn failed on purpose");`;
}

function codeOf(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "ok",
    (error: { code: string }) => error.code,
  );
}

describe("a hung instance", () => {
  // README.md, "Hot swaps, cold swaps, and restarts".
  test("README.md: a hot swap of a device hung in JavaScript fails, and the rack ends the old instance and resets the device from its old firmware", async () => {
    const created = await app();
    const { running } = await startRack(RACK, options(created));
    const spin = codeOf(running.call("jam.jam", "spin", undefined));
    await Bun.sleep(100);
    await created.write("devices/jam.ts", jam(created, { version: "v2" }));
    const error = await errorOf(running.swap("jam"));
    expect([error.code, error.message]).toEqual([
      "RACK_HOOK_FAILED",
      "jam: deactivate timed out after 1000 ms",
    ]);
    expect(await spin).toBe("RACK_DEVICE_FAULT");
    await waitFor(() => jamStatus(running).state === "online", 5_000);
    expect(await running.call("jam.jam", "version", undefined)).toBe("v1");
    expect(jamStatus(running)).toMatchObject({
      crashes: 1,
      stuck: [],
      error: {
        code: "RACK_DEVICE_FAULT",
        message: "jam: the old instance did not answer deactivate within 1000 ms",
      },
    });
  }, 15_000);

  test("README.md: a hot swap whose deactivate fails activates the old instance again, and its watchdogs watch it again", async () => {
    const created = await app({ deactivate: `throw new Error("deactivate failed on purpose");` });
    const { running } = await startRack(RACK, options(created, { watchdog: 1_000 }));
    await created.write("devices/jam.ts", jam(created, { version: "v2" }));
    const error = await errorOf(running.swap("jam"));
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(jamStatus(running).state).toBe("degraded");
    expect(await running.call("jam.jam", "version", undefined)).toBe("v1");
    // A hang bites again, and the device resets.
    const spin = await errorOf(running.call("jam.jam", "spin", undefined, { timeout: 5_000 }));
    expect(spin.code).toBe("RACK_DEVICE_FAULT");
    await waitFor(() => jamStatus(running).state === "online", 5_000);
    expect(jamStatus(running).crashes).toBe(1);
  }, 15_000);

  // README.md, "Stuck threads".
  test("README.md: a stop that a device doesn't answer within hookTimeout gets no further hooks, and its calls fail with RACK_DEVICE_FAULT", async () => {
    const created = await app({ swap: "cold" });
    const { running } = await startRack(RACK, options(created, { drainTimeout: 2_000 }));
    const spin = codeOf(running.call("jam.jam", "spin", undefined));
    await Bun.sleep(100);
    const started = performance.now();
    const [result] = await running.restart("jam");
    const elapsed = performance.now() - started;
    expect(result?.error).toBeUndefined();
    expect(await spin).toBe("RACK_DEVICE_FAULT");
    // One hookTimeout for deactivate; no drainTimeout and no powerOff after it.
    expect(elapsed).toBeLessThan(3_000);
    expect(jamStatus(running).state).toBe("online");
    expect(await running.call("jam.jam", "inc", undefined)).toBe(1);
  }, 15_000);
});

describe("a thread stuck in native code", () => {
  // README.md, "Stuck threads".
  test("README.md: a cold restart starts the new instance only once the old instance's thread has stopped", async () => {
    const created = await app({ swap: "cold" });
    const pipe = await pipeIn(created);
    const { running, rec } = await startRack(RACK, options(created));
    void codeOf(running.call("jam.jam", "read", pipe));
    await Bun.sleep(100);
    const restart = running.restart("jam");
    // The old instance powers off once deactivate went unanswered; its thread still blocks.
    await waitFor(
      () => rec.events.some((event) => event.type === "power" && event.state === "off"),
      5_000,
    );
    await Bun.sleep(300);
    const released = Date.now();
    expect(await release(pipe)).toBe(true);
    const [result] = await restart;
    expect(result?.error).toBeUndefined();
    const runs = await powerOns(created);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.time).toBeGreaterThanOrEqual(released);
    expect(jamStatus(running)).toMatchObject({ state: "online", stuck: [] });
  }, 15_000);

  test("README.md: a cold restart whose old thread stays stuck fails, faults the slot, and nothing of the device starts until the thread stops", async () => {
    const created = await app({ swap: "cold" });
    const pipe = await pipeIn(created);
    const { running, rec } = await startRack(RACK, options(created));
    const firmware = jamStatus(running).firmware;
    const read = codeOf(running.call("jam.jam", "read", pipe));
    await Bun.sleep(100);
    const error = await errorOf(running.restart("jam"));
    expect(error.code).toBe("RACK_DEVICE_FAULT");
    expect(error.message).toContain("stuck in native code");
    expect(await read).toBe("RACK_DEVICE_FAULT");
    const status = jamStatus(running);
    expect(status).toMatchObject({
      state: "faulted",
      firmware: null,
      stuck: [{ firmware, since: expect.any(Number) }],
      error: { code: "RACK_DEVICE_FAULT" },
    });
    expect(rec.events).toContainEqual(
      expect.objectContaining({
        type: "fault",
        device: "jam",
        firmware,
        reset: false,
        error: expect.objectContaining({
          message: expect.stringContaining("stuck in native code"),
        }),
      }),
    );
    const started = performance.now();
    const again = await errorOf(running.restart("jam"));
    expect(again.code).toBe("RACK_SWAP_REJECTED");
    expect(again.message).toContain("stuck in native code");
    expect(performance.now() - started).toBeLessThan(900);
    expect(await powerOns(created)).toHaveLength(1);
    // Once the thread stops, the device restarts.
    expect(await release(pipe)).toBe(true);
    await waitFor(() => jamStatus(running).stuck.length === 0, 5_000);
    const [result] = await running.restart("jam");
    expect(result?.error).toBeUndefined();
    expect(jamStatus(running).state).toBe("online");
    expect(await running.call("jam.jam", "inc", undefined)).toBe(1);
  }, 15_000);

  test("README.md: a hot swap of a device stuck in native code faults the slot while the thread is stuck, and a swap brings it back after", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running } = await startRack(RACK, options(created));
    const read = codeOf(running.call("jam.jam", "read", pipe));
    await Bun.sleep(100);
    await created.write("devices/jam.ts", jam(created, { version: "v2" }));
    const error = await errorOf(running.swap("jam"));
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(await read).toBe("RACK_DEVICE_FAULT");
    await waitFor(() => jamStatus(running).state === "faulted", 5_000);
    // One crash, the hang; the reset doesn't count as more, since it never tried to start.
    expect(jamStatus(running)).toMatchObject({
      crashes: 1,
      error: {
        code: "RACK_DEVICE_FAULT",
        message: expect.stringContaining("stuck in native code"),
      },
    });
    expect(jamStatus(running).stuck).toHaveLength(1);
    expect(await release(pipe)).toBe(true);
    await waitFor(() => jamStatus(running).stuck.length === 0, 5_000);
    await running.swap("jam");
    expect(jamStatus(running).state).toBe("online");
    expect(await running.call("jam.jam", "version", undefined)).toBe("v2");
  }, 15_000);

  test("README.md: a hot swap whose new instance gets stuck keeps the old one serving, and the next swap fails until the thread stops", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running } = await startRack(RACK, options(created));
    const stuck = `readFileSync(${JSON.stringify(pipe)});`;
    await created.write("devices/jam.ts", jam(created, { version: "v2", powerOn: stuck }));
    const error = await errorOf(running.swap("jam"));
    expect([error.code, error.message]).toEqual([
      "RACK_HOOK_FAILED",
      "jam: powerOn timed out after 1000 ms",
    ]);
    expect(await running.call("jam.jam", "version", undefined)).toBe("v1");
    const status = jamStatus(running);
    expect(status.state).toBe("degraded");
    // A stuck thread lists the listeners it keeps, as panels-as-devices decides; jam has none.
    expect(status.stuck).toEqual([
      { firmware: expect.any(String), since: expect.any(Number), listeners: [] },
    ]);
    expect(status.stuck[0]?.firmware).not.toBe(status.firmware);
    const refused = await errorOf(running.swap("jam"));
    expect(refused.code).toBe("RACK_SWAP_REJECTED");
    expect(refused.message).toContain("stuck in native code");
    expect(await release(pipe)).toBe(true);
    await waitFor(() => jamStatus(running).stuck.length === 0, 5_000);
    await created.write("devices/jam.ts", jam(created, { version: "v3" }));
    await running.swap("jam");
    expect(await running.call("jam.jam", "version", undefined)).toBe("v3");
  }, 15_000);

  test("README.md: unplugging a device whose thread is stuck fails with RACK_DEVICE_FAULT and keeps it in the rack until the thread stops", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running } = await startRack(RACK, options(created));
    void codeOf(running.call("jam.jam", "read", pipe));
    await Bun.sleep(100);
    const error = await errorOf(running.unplug("jam"));
    expect(error.code).toBe("RACK_DEVICE_FAULT");
    expect(jamStatus(running)).toMatchObject({ state: "faulted", firmware: null });
    expect(jamStatus(running).stuck).toHaveLength(1);
    expect((await errorOf(running.unplug("jam"))).code).toBe("RACK_DEVICE_FAULT");
    expect(await release(pipe)).toBe(true);
    await waitFor(() => jamStatus(running).stuck.length === 0, 5_000);
    await running.unplug("jam");
    expect(running.status()).toEqual([]);
  }, 15_000);

  test("README.md: a slot that a watchdog bite left faulted restarts only once the stuck thread has stopped", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running } = await startRack(RACK, options(created, { watchdog: 1_000 }));
    void codeOf(running.call("jam.jam", "read", pipe));
    await waitFor(() => jamStatus(running).state === "faulted", 8_000);
    expect(jamStatus(running).stuck).toHaveLength(1);
    expect((await errorOf(running.restart("jam"))).code).toBe("RACK_SWAP_REJECTED");
    expect(await release(pipe)).toBe(true);
    await waitFor(() => jamStatus(running).stuck.length === 0, 5_000);
    await running.restart("jam");
    expect(jamStatus(running).state).toBe("online");
  }, 15_000);

  test("a reset waits for the threads the rack is still ending: a bite during a hot swap that then fails leaves the slot faulted", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running } = await startRack(
      RACK,
      options(created, { watchdog: 1_000, hookTimeout: 4_000 }),
    );
    const marker = join(created.dir, "powering-on");
    await created.write(
      "devices/jam.ts",
      jam(created, { version: "v2", powerOn: failing(marker) }),
    );
    const swap = errorOf(running.swap("jam"));
    // Once the new instance is in powerOn, the old one blocks, and the watchdog bites it. When
    // the swap fails, the reset must wait for the bitten thread, which then turns out stuck.
    await waitFor(() => existsSync(marker), 5_000);
    void codeOf(running.call("jam.jam", "read", pipe));
    expect((await swap).code).toBe("RACK_HOOK_FAILED");
    await waitFor(() => jamStatus(running).state === "faulted", 8_000);
    // The bite is the only crash: the reset didn't try to start beside the thread.
    expect(jamStatus(running)).toMatchObject({ crashes: 1, stuck: [expect.anything()] });
    expect(await powerOns(created)).toHaveLength(1);
  }, 20_000);

  test("a restart right after a failed swap waits for the threads the rack is still ending", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running } = await startRack(
      RACK,
      options(created, { watchdog: 1_000, hookTimeout: 4_000 }),
    );
    // Three crashes, so the coming bite reaches the crash limit and nothing resets the slot.
    for (let crash = 0; crash < 3; crash++) {
      await codeOf(running.call("jam.jam", "crash", undefined));
      await waitFor(() => jamStatus(running).state === "online", 5_000);
    }
    const marker = join(created.dir, "powering-on");
    await created.write(
      "devices/jam.ts",
      jam(created, { version: "v2", powerOn: failing(marker) }),
    );
    const swap = errorOf(running.swap("jam"));
    await waitFor(() => existsSync(marker), 5_000);
    void codeOf(running.call("jam.jam", "read", pipe));
    expect((await swap).code).toBe("RACK_HOOK_FAILED");
    expect(jamStatus(running).state).toBe("faulted");
    // The bitten thread is still being ended: the restart waits for it, and finds it stuck.
    await created.write("devices/jam.ts", jam(created, { version: "v3" }));
    expect((await errorOf(running.restart("jam"))).code).toBe("RACK_SWAP_REJECTED");
    expect(jamStatus(running).stuck).toHaveLength(1);
    expect((await powerOns(created)).map((run) => run.version)).toEqual(["v1", "v1", "v1", "v1"]);
  }, 25_000);

  test("README.md: stop() waits for a stuck thread for one hookTimeout, and logs it", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running, rec } = await startRack(RACK, options(created));
    void codeOf(running.call("jam.jam", "read", pipe));
    await Bun.sleep(100);
    const started = performance.now();
    await running.stop();
    const elapsed = performance.now() - started;
    // One hookTimeout for the unanswered deactivate, and one for the thread.
    expect(elapsed).toBeGreaterThan(1_800);
    expect(elapsed).toBeLessThan(3_000);
    expect(rec.logs.map((entry) => entry.message)).toContainEqual(
      expect.stringContaining("it is stuck in native code"),
    );
  }, 15_000);

  test("README.md: firmware whose loading gets stuck isn't loaded again until the thread stops", async () => {
    const created = await app();
    const pipe = await pipeIn(created);
    const { running, rec } = await startRack(RACK, options(created));
    const top = `readFileSync(${JSON.stringify(pipe)});`;
    await created.write("devices/jam.ts", jam(created, { version: "v2", top }));
    expect((await errorOf(running.swap("jam"))).code).toBe("RACK_SWAP_REJECTED");
    const started = performance.now();
    const again = await errorOf(running.swap("jam"));
    expect(again.code).toBe("RACK_SWAP_REJECTED");
    expect(again.message).toContain("stuck in native code");
    expect(performance.now() - started).toBeLessThan(900);
    expect(await running.call("jam.jam", "version", undefined)).toBe("v1");
    expect(await release(pipe)).toBe(true);
    await waitFor(
      () =>
        rec.logs.some((entry) => /the stuck thread of firmware \w+ stopped$/.test(entry.message)),
      5_000,
    );
    await created.write("devices/jam.ts", jam(created, { version: "v3" }));
    await running.swap("jam");
    expect(await running.call("jam.jam", "version", undefined)).toBe("v3");
  }, 15_000);
});
