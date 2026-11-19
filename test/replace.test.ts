/**
 * Tests for the kinds of replacement: hot swaps, cold swaps that never overlap two instances,
 * restarts that drop the state and reload the direct consumers, and group replacements for
 * contract changes.
 *
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#three-ways-to-replace-an-instance
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#cold-swaps
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#restarts
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#contract-changes
 */
import { afterEach, describe, expect, test } from "bun:test";
import { slot } from "rack42u";
import { errorOf, type TempApp, tempApp, useRacks } from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Count = connector("demo.count/v1", {
  inc: rpc(v.undefined(), v.object({ n: v.number(), version: v.string() })),
});
export const Store = connector("demo.store/v1", { id: rpc(v.undefined(), v.string()) });
export const Client = connector("demo.client/v1", { seen: rpc(v.undefined(), v.string()) });
`;

/**
 * A counter that holds an exclusive lock file from powerOn to powerOff, so that two of its
 * instances can never run at the same time.
 */
function printer(options: { cold: boolean; version?: string; extra?: string }): string {
  return `import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { device } from "rack42u";
import { Count } from "../connectors.ts";

const VERSION = "${options.version ?? "v1"}";
let n = 0;
let lock: number | undefined;

export default device({
  model: "printer",${options.cold ? '\n  swap: "cold",' : ""}
  provides: { count: Count },
  powerOn(ctx) {
    lock = openSync(join(ctx.baseDir, "printer.lock"), "wx");
    return { count: { inc: () => ({ n: ++n, version: VERSION }) } };
  },${options.extra ?? ""}
  powerOff(ctx) {
    if (lock !== undefined) closeSync(lock);
    unlinkSync(join(ctx.baseDir, "printer.lock"));
  },
  snapshot: () => ({ n }),
  restore(ctx, state) {
    n = (state as { n: number }).n;
  },
});
`;
}

/** A store that answers with an id of its own instance, and counts. */
const STORE = `import { device } from "rack42u";
import { Count, Store } from "../connectors.ts";

const id = crypto.randomUUID();
let n = 0;

export default device({
  model: "store",
  provides: { store: Store, count: Count },
  powerOn: () => ({
    store: { id: () => id },
    count: { inc: () => ({ n: ++n, version: "v1" }) },
  }),
  snapshot: () => ({ n }),
  restore(ctx, state) {
    n = (state as { n: number }).n;
  },
});
`;

/** A client that reads the store's id in powerOn and reports it. */
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

interface Counted {
  n: number;
  version: string;
}

describe("cold swaps", () => {
  // @doc docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts
  test('a device that declares swap: "cold" stops before its new instance starts, and keeps its state', async () => {
    const cold = await app({ "devices/printer.ts": printer({ cold: true }) });
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/printer.ts") } },
      { baseDir: cold.dir },
    );
    await running.call("printer.count", "inc", undefined);
    await running.call("printer.count", "inc", undefined);
    await cold.write("devices/printer.ts", printer({ cold: true, version: "v2" }));
    const [result] = await running.reload();
    expect([result?.device, result?.mode, result?.error]).toEqual(["printer", "cold", undefined]);
    expect(await running.call("printer.count", "inc", undefined)).toEqual({ n: 3, version: "v2" });
    expect(rec.events).toContainEqual(
      expect.objectContaining({ type: "swap", device: "printer", mode: "cold" }),
    );
  });

  test('the same device without swap: "cold" cannot be hot-swapped, and keeps serving', async () => {
    const hot = await app({ "devices/printer.ts": printer({ cold: false }) });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/printer.ts") } },
      { baseDir: hot.dir },
    );
    await running.call("printer.count", "inc", undefined);
    await hot.write("devices/printer.ts", printer({ cold: false, version: "v2" }));
    const [result] = await running.reload();
    expect([result?.mode, result?.error?.code]).toEqual(["hot", "RACK_HOOK_FAILED"]);
    expect(await running.call("printer.count", "inc", undefined)).toEqual({ n: 2, version: "v1" });
  });

  test("calls that arrive during a cold swap wait for the new instance instead of failing", async () => {
    const slow = "\n  async selfTest() {\n    await Bun.sleep(150);\n  },";
    const cold = await app({ "devices/printer.ts": printer({ cold: true, extra: slow }) });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/printer.ts") } },
      { baseDir: cold.dir },
    );
    await cold.write("devices/printer.ts", printer({ cold: true, version: "v2", extra: slow }));
    const reload = running.reload();
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      calls.push(running.call("printer.count", "inc", undefined));
      await Bun.sleep(10);
    }
    expect((await reload)[0]?.error).toBeUndefined();
    const counts = (await Promise.all(calls)) as Counted[];
    expect(counts.map((count) => count.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(counts.at(-1)?.version).toBe("v2");
  });

  test("when a cold swap fails to start, the old firmware starts again from its snapshot", async () => {
    const failing =
      '\n  selfTest() {\n    if (VERSION === "v2") throw new Error("v2 is broken");\n  },';
    const cold = await app({ "devices/printer.ts": printer({ cold: true, extra: failing }) });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/printer.ts") } },
      { baseDir: cold.dir },
    );
    await running.call("printer.count", "inc", undefined);
    await cold.write("devices/printer.ts", printer({ cold: true, version: "v2", extra: failing }));
    const [result] = await running.reload();
    expect([result?.mode, result?.error?.code]).toEqual(["cold", "RACK_HOOK_FAILED"]);
    expect(running.status()[0]?.state).toBe("degraded");
    expect(await running.call("printer.count", "inc", undefined)).toEqual({ n: 2, version: "v1" });
  });

  test("a cold swap that fails to start reports the slot degraded from the moment the old firmware is installed again", async () => {
    const failing =
      '\n  selfTest() {\n    if (VERSION === "v2") throw new Error("v2 is broken");\n  },';
    const cold = await app({ "devices/printer.ts": printer({ cold: true, extra: failing }) });
    const { running } = await startRack(
      { slots: { 1: slot("./devices/printer.ts") } },
      { baseDir: cold.dir },
    );
    const v1 = running.status()[0]?.firmware;
    // The status each time an instance powers on, read in the listener, where nothing else can
    // run between the install and the read.
    const seen: string[] = [];
    running.subscribe((event) => {
      if (event.type !== "power" || event.state !== "on") return;
      seen.push(`${event.firmware === v1 ? "v1" : "v2"} ${running.status()[0]?.state}`);
    });
    await cold.write("devices/printer.ts", printer({ cold: true, version: "v2", extra: failing }));
    await running.reload();
    expect(seen).toEqual(["v1 degraded"]);
  });
});

// @doc docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts
describe("restarts", () => {
  const RACK = { slots: { 1: slot("./devices/store.ts"), 2: slot("./devices/client.ts") } };

  test("restart starts a device from scratch, and its direct consumers reload against it", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(RACK, { baseDir: created.dir });
    await running.call("store.count", "inc", undefined);
    const results = await running.restart("store");
    expect(results.map((result) => [result.device, result.mode, result.error])).toEqual([
      ["store", "restart", undefined],
      ["client", "hot", undefined],
    ]);
    // The store lost its count, and the client's powerOn saw the new store.
    expect(await running.call("store.count", "inc", undefined)).toEqual({ n: 1, version: "v1" });
    expect(await running.call("client.client", "seen", undefined)).toBe(
      await running.call("store.store", "id", undefined),
    );
  });

  test("restart with cascade: false leaves the consumers running", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(RACK, { baseDir: created.dir });
    const before = await running.call("client.client", "seen", undefined);
    const results = await running.restart("store", { cascade: false });
    expect(results.map((result) => result.device)).toEqual(["store"]);
    expect(await running.call("client.client", "seen", undefined)).toBe(before);
    expect(await running.call("store.store", "id", undefined)).not.toBe(before);
  });

  test("a restart that fails to start brings the old firmware back without state", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(RACK, { baseDir: created.dir });
    await running.call("store.count", "inc", undefined);
    await created.write(
      "devices/store.ts",
      STORE.replace(
        "  powerOn: () => ({",
        '  powerOn: () => {\n    throw new Error("broken");\n  },\n  unused: () => ({',
      ),
    );
    const error = await errorOf(running.restart("store"));
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(running.status()[0]?.state).toBe("degraded");
    expect(await running.call("store.count", "inc", undefined)).toEqual({ n: 1, version: "v1" });
  });
});

// @doc docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts
describe("contract changes", () => {
  const RACK = { slots: { 1: slot("./devices/store.ts"), 2: slot("./devices/client.ts") } };

  test("a contract change replaces the provider and its consumers together", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(RACK, { baseDir: created.dir });
    await running.call("store.count", "inc", undefined);
    await created.write("connectors.ts", CONNECTORS.replace("demo.store/v1", "demo.store/v2"));
    const results = await running.reload();
    expect(results.map((result) => [result.device, result.mode, result.error])).toEqual([
      ["store", "cold", undefined],
      ["client", "cold", undefined],
    ]);
    // The store kept its count through the group's snapshot and restore.
    expect(await running.call("store.count", "inc", undefined)).toEqual({ n: 2, version: "v1" });
    expect(await running.call("client.client", "seen", undefined)).toBe(
      await running.call("store.store", "id", undefined),
    );
  });

  test("a contract change that a consumer's firmware does not follow is refused, and nothing stops", async () => {
    const created = await app({ "devices/store.ts": STORE, "devices/client.ts": CLIENT });
    const { running } = await startRack(RACK, { baseDir: created.dir });
    const before = await running.call("store.store", "id", undefined);
    await created.write(
      "devices/store.ts",
      STORE.replace(
        'import { Count, Store } from "../connectors.ts";',
        'import { connector, rpc } from "rack42u";\nimport * as v from "valibot";\nimport { Count } from "../connectors.ts";\n\nconst Store = connector("demo.store/v2", { id: rpc(v.undefined(), v.string()) });',
      ),
    );
    const [result] = await running.reload();
    expect([result?.device, result?.error?.code]).toEqual(["store", "RACK_SWAP_REJECTED"]);
    expect(result?.error?.message).toContain("client.store needs demo.store/v1");
    expect(result?.error?.message).toContain("client has no new firmware to replace with it");
    expect(await running.call("store.store", "id", undefined)).toBe(before);
  });
});
