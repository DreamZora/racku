/**
 * Tests for update safety: probation with passive fallback to known-good firmware, active
 * rollback, the bounded update history, and the firmware bundles it keeps.
 *
 * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#known-good-firmware-and-probation
 * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#passive-fallback
 * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#active-rollback
 * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#update-history
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type RackHandle,
  type SlotStatus,
  slot,
  type UpdateCause,
  type UpdateRecord,
} from "rack42u";
import { errorOf, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Count = connector("demo.count/v1", {
  inc: rpc(v.undefined(), v.object({ n: v.number(), version: v.string() })),
  crash: rpc(v.undefined(), v.undefined()),
});
export const Base = connector("demo.base/v1", { ping: rpc(v.undefined(), v.string()) });
export const Store = connector("demo.store/v1", { id: rpc(v.undefined(), v.string()) });
export const Client = connector("demo.client/v1", { seen: rpc(v.undefined(), v.string()) });
`;

/** A counter whose version shows in its answers; it can crash on demand or on every inc. */
function counter(version: string, options: { crashOnInc?: boolean; needsBase?: boolean } = {}) {
  return `import { device } from "rack42u";
import { Base, Count } from "../connectors.ts";

let n = 0;

export default device({
  model: "counter",${options.needsBase ? "\n  needs: { base: Base }," : ""}
  provides: { count: Count },
  powerOn: () => ({
    count: {
      inc: () => {
        ${options.crashOnInc ? "setTimeout(() => process.exit(3), 0);" : ""}
        return { n: ++n, version: "${version}" };
      },
      crash: () => {
        setTimeout(() => process.exit(3), 0);
      },
    },
  }),
  snapshot: () => ({ n }),
  restore(ctx, state) {
    n = (state as { n: number }).n;
  },
});
`;
}

const BASE = `import { device } from "rack42u";
import { Base } from "../connectors.ts";

export default device({
  model: "base",
  provides: { base: Base },
  powerOn: () => ({ base: { ping: () => "pong" } }),
});
`;

/** A store that can crash on demand; its connector file decides its contract. */
const STORE = `import { device } from "rack42u";
import { Count, Store } from "../connectors.ts";

const id = crypto.randomUUID();

export default device({
  model: "store",
  provides: { store: Store, count: Count },
  powerOn: () => ({
    store: { id: () => id },
    count: {
      inc: () => ({ n: 0, version: "store" }),
      crash: () => {
        setTimeout(() => process.exit(3), 0);
      },
    },
  }),
});
`;

const CLIENT = `import { device } from "rack42u";
import { Client, Store } from "../connectors.ts";

export default device({
  model: "client",
  needs: { store: Store },
  provides: { client: Client },
  async powerOn(ctx) {
    const seen = await ctx.ports.store.id(undefined);
    return { client: { seen: () => seen } };
  },
});
`;

async function app(files: Record<string, string>): Promise<TempApp> {
  const created = await tempApp();
  apps.push(created);
  await created.write("connectors.ts", CONNECTORS);
  for (const [path, content] of Object.entries(files)) await created.write(path, content);
  return created;
}

const COUNTER_RACK = { slots: { 1: slot("./devices/base.ts"), 2: slot("./devices/counter.ts") } };

function counterStatus(running: RackHandle) {
  return running.status().find((s) => s.name === "counter");
}

async function inc(running: RackHandle): Promise<{ n: number; version: string }> {
  return (await running.call("counter.count", "inc", undefined)) as { n: number; version: string };
}

/**
 * The status of a device each time one of its instances powers on, read in the event listener,
 * where nothing else can run between the install and the read.
 */
function poweredOn(running: RackHandle, device: string): SlotStatus[] {
  const seen: SlotStatus[] = [];
  running.subscribe((event) => {
    if (event.type !== "power" || event.state !== "on" || event.device !== device) return;
    const status = running.status().find((s) => s.name === device);
    if (status !== undefined) seen.push(status);
  });
  return seen;
}

// @doc docs/guides/updates.md#fallback
describe("passive fallback", () => {
  // README.md, "Update safety".
  test("a new instance that crashes on probation falls back to the known-good firmware", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir });
    const v1 = counterStatus(running)?.firmware;
    await created.write("devices/counter.ts", counter("v2", { crashOnInc: true }));
    await running.reload();
    const v2 = counterStatus(running)?.firmware;
    expect(counterStatus(running)).toMatchObject({
      knownGood: v1,
      probationUntil: expect.any(Number),
    });
    await inc(running);
    await waitFor(
      () => counterStatus(running)?.firmware === v1 && counterStatus(running)?.state === "degraded",
    );
    expect(counterStatus(running)?.error?.code).toBe("RACK_DEVICE_FAULT");
    expect(await inc(running)).toEqual({ n: 1, version: "v1" });
    expect(running.history("counter")[0]).toMatchObject({
      cause: "fallback",
      mode: "restart",
      from: v2,
      to: v1,
      ok: true,
      error: { code: "RACK_DEVICE_FAULT" },
    });
  });

  test("a fallback reports the slot degraded, with the crash, from the moment the known-good instance is installed", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir });
    const v1 = counterStatus(running)?.firmware;
    await created.write("devices/counter.ts", counter("v2", { crashOnInc: true }));
    await running.reload();
    const seen = poweredOn(running, "counter");
    await inc(running);
    await waitFor(() => seen.length > 0);
    expect(seen[0]).toMatchObject({
      firmware: v1,
      state: "degraded",
      error: { code: "RACK_DEVICE_FAULT" },
    });
  });

  test("after probation, the new firmware is known-good, and a crash resets it as usual", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir, probation: 100 });
    await created.write("devices/counter.ts", counter("v2"));
    await running.reload();
    const v2 = counterStatus(running)?.firmware;
    await waitFor(() => counterStatus(running)?.knownGood === v2);
    expect(counterStatus(running)?.probationUntil).toBeUndefined();
    await running.call("counter.count", "crash", undefined);
    await waitFor(
      () => counterStatus(running)?.state === "online" && counterStatus(running)?.crashes === 1,
    );
    expect(counterStatus(running)?.firmware).toBe(v2);
  });

  test("probation: 0 turns fallback off", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir, probation: 0 });
    await created.write("devices/counter.ts", counter("v2"));
    await running.reload();
    const v2 = counterStatus(running)?.firmware;
    expect(counterStatus(running)?.knownGood).toBe(v2);
    await running.call("counter.count", "crash", undefined);
    await waitFor(
      () => counterStatus(running)?.state === "online" && counterStatus(running)?.crashes === 1,
    );
    expect(counterStatus(running)?.firmware).toBe(v2);
  });

  test("a group replaced together falls back together", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/store.ts"), 2: slot("./devices/client.ts") } },
      { baseDir: created.dir },
    );
    const before = Object.fromEntries(running.status().map((s) => [s.name, s.firmware]));
    await created.write("connectors.ts", CONNECTORS.replace("demo.store/v1", "demo.store/v2"));
    expect((await running.reload()).map((result) => result.mode)).toEqual(["cold", "cold"]);
    await running.call("store.count", "crash", undefined);
    await waitFor(() =>
      running.status().every((s) => s.firmware === before[s.name] && s.state !== "resetting"),
    );
    expect(await running.call("client.client", "seen", undefined)).toBe(
      await running.call("store.store", "id", undefined),
    );
    const fallbacks = running.history().filter((record) => record.cause === "fallback");
    expect(fallbacks.map((record) => [record.device, record.ok])).toEqual([
      ["client", true],
      ["store", true],
    ]);
  });

  test("a group fallback reports the crashed device degraded, with the crash, from the moment its known-good instance is installed", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/store.ts"), 2: slot("./devices/client.ts") } },
      { baseDir: created.dir },
    );
    const good = running.status()[0]?.firmware;
    await created.write("connectors.ts", CONNECTORS.replace("demo.store/v1", "demo.store/v2"));
    await running.reload();
    const seen = poweredOn(running, "store");
    await running.call("store.count", "crash", undefined);
    await waitFor(() => seen.length > 0);
    expect(seen[0]).toMatchObject({
      firmware: good,
      state: "degraded",
      error: { code: "RACK_DEVICE_FAULT" },
    });
  });
});

// @doc docs/guides/updates.md#rollback
describe("active rollback", () => {
  test("rollback goes back to the firmware before the current one, keeping the state", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir });
    const v1 = counterStatus(running)?.firmware;
    await inc(running);
    await created.write("devices/counter.ts", counter("v2"));
    await running.reload();
    const v2 = counterStatus(running)?.firmware;
    expect(await inc(running)).toEqual({ n: 2, version: "v2" });
    const results = await running.rollback("counter");
    expect(results.map((result) => [result.device, result.from, result.to, result.mode])).toEqual([
      ["counter", v2 ?? null, v1 ?? null, "hot"],
    ]);
    expect(await inc(running)).toEqual({ n: 3, version: "v1" });
    expect(running.history("counter")[0]).toMatchObject({
      cause: "rollback",
      from: v2,
      to: v1,
      ok: true,
    });
    // A rollback to the known-good firmware starts no probation.
    expect(counterStatus(running)?.probationUntil).toBeUndefined();
  });

  test("rollback with to goes back to any firmware the history keeps", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir });
    const v1 = counterStatus(running)?.firmware as string;
    for (const version of ["v2", "v3"]) {
      await created.write("devices/counter.ts", counter(version));
      await running.reload();
    }
    await running.rollback("counter", { to: v1 });
    expect((await inc(running)).version).toBe("v1");
    const missing = await errorOf(running.rollback("counter", { to: "nope0000" }));
    expect([missing.code, missing.message]).toEqual([
      "RACK_SWAP_REJECTED",
      "firmware nope0000 of counter is no longer kept",
    ]);
  });

  test("rolling back a device of a group replacement takes the whole group back", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/store.ts"), 2: slot("./devices/client.ts") } },
      { baseDir: created.dir },
    );
    const before = running.status().map((s) => s.firmware);
    await created.write("connectors.ts", CONNECTORS.replace("demo.store/v1", "demo.store/v2"));
    await running.reload();
    const results = await running.rollback("store");
    expect(results.map((result) => [result.device, result.mode])).toEqual([
      ["store", "cold"],
      ["client", "cold"],
    ]);
    expect(running.status().map((s) => s.firmware)).toEqual(before);
    expect(await running.call("client.client", "seen", undefined)).toBe(
      await running.call("store.store", "id", undefined),
    );
  });

  test("a rollback to firmware with other needs than the running plan is refused", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir });
    await created.write("devices/counter.ts", counter("v2", { needsBase: true }));
    await running.reload();
    const v2 = counterStatus(running)?.firmware;
    const error = await errorOf(running.rollback("counter"));
    expect(error.code).toBe("RACK_SWAP_REJECTED");
    expect(error.message).toContain("has other needs than the running plan");
    expect(counterStatus(running)?.firmware).toBe(v2);
  });
});

// @doc docs/guides/updates.md#history
describe("update history", () => {
  test("history lists every update newest first, for the rack or one device, within historyLimit", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const { running } = await startRack(COUNTER_RACK, { baseDir: created.dir, historyLimit: 3 });
    for (const version of ["v2", "v3", "v4"]) {
      await created.write("devices/counter.ts", counter(version));
      await running.reload();
    }
    await running.swap("base");
    // The record types are part of the package's API.
    const all: UpdateRecord[] = running.history();
    const causes: UpdateCause[] = all.map((record) => record.cause);
    expect(causes).toEqual(["swap", "reload", "reload"]);
    expect(all.map((record) => [record.device, record.cause, record.mode])).toEqual([
      ["base", "swap", "hot"],
      ["counter", "reload", "hot"],
      ["counter", "reload", "hot"],
    ]);
    expect(all[0]?.seq).toBeGreaterThan(all[1]?.seq as number);
    expect(running.history("base")).toHaveLength(1);
  });

  test("the rack deletes the firmware bundles it built once nothing needs them", async () => {
    const created = await app({ "devices/base.ts": BASE, "devices/counter.ts": counter("v1") });
    const firmwareDir = join(created.dir, ".rack", "firmware");
    const { running } = await startRack(COUNTER_RACK, {
      baseDir: created.dir,
      historyLimit: 1,
      probation: 0,
    });
    await created.write(".rack/firmware/other-rack-0000.js", "// built by another rack\n");
    for (const version of ["v2", "v3", "v4", "v5"]) {
      await created.write("devices/counter.ts", counter(version));
      await running.reload();
    }
    const bundles = (await readdir(firmwareDir)).sort();
    const counters = bundles.filter((name) => name.startsWith("counter-"));
    // v5 runs; v4 is in the one kept record. v1 to v3 are gone.
    expect(counters).toHaveLength(2);
    expect(bundles).toContain("other-rack-0000.js");
  });
});
