/**
 * Tests for the swap process: swap, reload, plug, unplug, state handover, and rollback.
 *
 * @decision .agents/decisions/261112_035943-hot-swap.md#the-swap-sequence
 * @decision .agents/decisions/261116_024226-backplane-links.md#in-flight-calls-holding-and-draining
 * @decision .agents/decisions/261115_222025-p0-api-details.md#rack-handle
 * @decision .agents/decisions/261115_222025-p0-api-details.md#error-codes
 */
import { afterEach, describe, expect, test } from "bun:test";
import { slot } from "rack42u";
import {
  codeOf,
  errorOf,
  FIXTURES,
  type TempApp,
  tempApp,
  useRacks,
  waitFor,
} from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** A temporary app holding a copy of the fixture devices. */
async function fixtureApp(): Promise<TempApp> {
  const app = await tempApp(["connectors.ts", "devices"], FIXTURES);
  apps.push(app);
  return app;
}

async function edit(app: TempApp, path: string, from: string, to: string): Promise<void> {
  const text = await app.read(path);
  if (!text.includes(from)) throw new Error(`${path} does not contain ${from}`);
  await app.write(path, text.replace(from, to));
}

interface Count {
  n: number;
  firmware: string;
  version: string;
}

describe("swap", () => {
  test("replaces the instance and hands in-memory state over", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/counter.ts") } });
    for (let i = 0; i < 3; i++) await running.call("counter.counter", "inc", undefined);
    await running.swap("counter");
    expect(((await running.call("counter.counter", "get", undefined)) as Count).n).toBe(3);
    expect(rec.events.map((e) => (e.type === "power" ? `${e.type}:${e.state}` : e.type))).toEqual([
      "power:on",
      "power:off",
      "swap",
    ]);
    expect(running.status()[0]?.state).toBe("online");
  });

  test("swaps to another device file under the same name", async () => {
    const app = await fixtureApp();
    await app.write(
      "devices/counter-v2.ts",
      (await app.read("devices/counter.ts")).replace('"v1"', '"v2"'),
    );
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/counter.ts") } },
      { baseDir: app.dir },
    );
    await running.call("counter.counter", "inc", undefined);
    const before = running.status()[0]?.firmware;
    await running.swap("counter", "./devices/counter-v2.ts");
    const after = (await running.call("counter.counter", "get", undefined)) as Count;
    expect(after).toMatchObject({ n: 1, version: "v2" });
    expect(after.firmware).not.toBe(before as string);
    expect(running.status()[0]?.source).toBe(`${app.dir}/devices/counter-v2.ts`);
    expect(rec.events.at(-1)).toMatchObject({
      type: "swap",
      action: "swap",
      from: before,
      to: after.firmware,
    });
  });

  test("a failing selfTest rolls back: the old instance keeps serving and the slot is degraded", async () => {
    const app = await fixtureApp();
    const broken = (await app.read("devices/counter.ts")).replace(
      "snapshot:",
      'selfTest() { throw new Error("not ready"); },\n  snapshot:',
    );
    await app.write("devices/counter-broken.ts", broken);
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/counter.ts") } },
      { baseDir: app.dir },
    );
    await running.call("counter.counter", "inc", undefined);
    const firmware = running.status()[0]?.firmware;

    const error = await errorOf(running.swap("counter", "./devices/counter-broken.ts"));
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(error.message).toContain("not ready");

    const status = running.status()[0];
    expect(status).toMatchObject({
      state: "degraded",
      firmware,
      error: { code: "RACK_HOOK_FAILED" },
    });
    expect(await running.call("counter.counter", "get", undefined)).toMatchObject({
      n: 1,
      firmware,
    });
    expect(rec.events.at(-1)).toMatchObject({ type: "swap", error: { code: "RACK_HOOK_FAILED" } });

    await running.swap("counter");
    expect(running.status()[0]?.state).toBe("online");
  });

  test("a failure after the handover reactivates the old instance", async () => {
    const app = await fixtureApp();
    const broken = (await app.read("devices/lifecycle.ts")).replace(
      'await step(ctx, "activate");',
      'await step(ctx, "activate");\n    throw new Error("cannot activate");',
    );
    await app.write("devices/lifecycle-broken.ts", broken);
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/lifecycle.ts") } },
      { baseDir: app.dir },
    );
    expect(await codeOf(running.swap("lifecycle", "./devices/lifecycle-broken.ts"))).toBe(
      "RACK_HOOK_FAILED",
    );
    const hooks = rec.logs
      .filter((e) => e.message === "hook")
      .map((e) => e.data as { hook: string; instance: string });
    const original = hooks[0]?.instance;
    expect(hooks.filter((h) => h.instance === original).map((h) => h.hook)).toEqual([
      "powerOn",
      "selfTest",
      "activate",
      "deactivate",
      "activate",
    ]);
    expect(running.status()[0]?.state).toBe("degraded");
  });

  // @decision .agents/decisions/261112_035943-hot-swap.md#the-swap-sequence
  test("runs the new instance's powerOn and selfTest before the old one deactivates", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/lifecycle.ts") } });
    await running.swap("lifecycle");
    const hooks = rec.logs
      .filter((e) => e.message === "hook")
      .map((e) => e.data as { hook: string; instance: string });
    const [old] = hooks;
    const sequence = hooks
      .slice(3)
      .map((h) => `${h.instance === old?.instance ? "old" : "new"}.${h.hook}`);
    expect(sequence).toEqual([
      "new.powerOn",
      "new.selfTest",
      "old.deactivate",
      "new.activate",
      "old.powerOff",
    ]);
  });

  test("rejects a swap that removes a port another device uses", async () => {
    const { running } = await startRack({
      slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") },
    });
    const error = await errorOf(running.swap("probe", "./devices/counter.ts"));
    expect(error.code).toBe("RACK_SWAP_REJECTED");
    expect(error.message).toContain("relay.target uses probe.probe");
    expect(await running.call("relay.relay", "call", { member: "double", input: 2 })).toEqual({
      ok: true,
      value: 4,
    });
  });

  test("rejects a swap that removes a port a panel route uses", async () => {
    const { running } = await startRack({
      slots: { 1: slot("./devices/web.ts") },
      panel: { http: { port: 0, routes: { "/web/*": "web.http" } } },
    });
    expect(await codeOf(running.swap("web", "./devices/probe.ts"))).toBe("RACK_SWAP_REJECTED");
  });

  test("rejects unknown device names with RACK_NO_ROUTE", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    expect(await codeOf(running.swap("ghost"))).toBe("RACK_NO_ROUTE");
    expect(await codeOf(running.unplug("ghost"))).toBe("RACK_NO_ROUTE");
  });

  test("a device file that fails to build is rejected with RACK_SWAP_REJECTED", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    expect(await codeOf(running.swap("probe", "./devices/missing.ts"))).toBe("RACK_SWAP_REJECTED");
    expect(running.status()[0]?.state).toBe("degraded");
    expect(await running.call("probe.probe", "echo", 1)).toBe(1);
  });

  test("requests are make before break: calls in flight finish on the old instance", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    const inFlight = running.call("probe.probe", "wait", { ms: 400 });
    let finished = false;
    void inFlight.then(() => {
      finished = true;
    });
    await Bun.sleep(20);
    const swapped = running.swap("probe");
    // The new instance serves new calls while the old one still holds the first call.
    await waitFor(() => rec.events.some((e) => e.type === "power" && e.state === "on"));
    expect(await running.call("probe.probe", "echo", 2)).toBe(2);
    expect(finished).toBe(false);
    expect(await inFlight).toBe("done");
    await swapped;
    expect(running.status()[0]?.state).toBe("online");
  });

  test("calls still running on a retired instance fail after drainTimeout", async () => {
    const { running } = await startRack(
      { slots: { 1: slot("./devices/probe.ts") } },
      { drainTimeout: 100 },
    );
    const inFlight = codeOf(running.call("probe.probe", "wait", { ms: 5_000 }));
    await Bun.sleep(20);
    await running.swap("probe");
    expect(await inFlight).toBe("RACK_LINK_DOWN");
  });

  test("no call is lost while the slot is paused for a state handover", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/counter.ts") } });
    const calls: Promise<unknown>[] = [];
    const swapped = running.swap("counter");
    for (let i = 0; i < 200; i++) {
      calls.push(running.call("counter.counter", "inc", undefined));
      if (i % 20 === 0) await Bun.sleep(1);
    }
    await Promise.all([swapped, ...calls]);
    expect(((await running.call("counter.counter", "get", undefined)) as Count).n).toBe(200);
  });

  test("a handover whose in-flight calls outlast drainTimeout rolls back", async () => {
    const { running } = await startRack(
      { slots: { 1: slot("./devices/counter.ts") } },
      { drainTimeout: 100 },
    );
    const slow = running.call("counter.counter", "slowInc", 400);
    await Bun.sleep(20);
    const error = await errorOf(running.swap("counter"));
    expect(error.code).toBe("RACK_SWAP_REJECTED");
    expect(error.message).toContain("did not finish within 100 ms");
    expect(await slow).toBe(1);
    expect(running.status()[0]?.state).toBe("degraded");
    expect(await running.call("counter.counter", "inc", undefined)).toBe(2);
  });

  test("management operations run one at a time in call order", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/counter.ts") } });
    await Promise.all([running.swap("counter"), running.swap("counter"), running.swap("counter")]);
    const swaps = rec.events.filter((e) => e.type === "swap");
    expect(swaps).toHaveLength(3);
    expect(swaps.every((e) => e.type === "swap" && e.error === undefined)).toBe(true);
  });
});

describe("plug and unplug", () => {
  test("plug powers a device on and wires it to the devices below", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await running.plug(3, slot("./devices/relay.ts"));
    expect(await running.call("relay.relay", "call", { member: "double", input: 4 })).toEqual({
      ok: true,
      value: 8,
    });
    expect(running.status().map((s) => s.name)).toEqual(["probe", "relay"]);
    expect(rec.events.at(-1)).toMatchObject({
      type: "swap",
      action: "plug",
      device: "relay",
      from: null,
    });
  });

  test.each([
    ["an occupied slot", 1, "./devices/counter.ts", "RACK_MANIFEST"],
    ["a duplicate name", 5, "./devices/probe.ts", "RACK_MANIFEST"],
    ["a need with no provider below", 1, "./devices/relay.ts", "RACK_MANIFEST"],
    ["a slot outside the rack", 99, "./devices/counter.ts", "RACK_MANIFEST"],
    ["a file that fails to build", 5, "./devices/missing.ts", "RACK_SWAP_REJECTED"],
  ])("plug rejects %s", async (_label, u, source, code) => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    expect(await codeOf(running.plug(u, slot(source)))).toBe(code);
    expect(running.status().map((s) => s.name)).toEqual(["probe"]);
  });

  test("unplug powers a device off and removes it", async () => {
    const { running, rec } = await startRack({
      slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") },
    });
    await running.unplug("relay");
    expect(running.status().map((s) => s.name)).toEqual(["probe"]);
    expect(await codeOf(running.call("relay.relay", "received", undefined))).toBe("RACK_NO_ROUTE");
    expect(rec.events.at(-1)).toMatchObject({ type: "swap", action: "unplug", to: null });
  });

  test("unplug rejects a device that others still use", async () => {
    const { running } = await startRack({
      slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") },
    });
    const error = await errorOf(running.unplug("probe"));
    expect(error.code).toBe("RACK_SWAP_REJECTED");
    expect(error.message).toContain("still used by relay.target");
  });
});

describe("reload", () => {
  test("swaps only the devices whose firmware changed and keeps their state", async () => {
    const app = await fixtureApp();
    const { running } = await startRack(
      { slots: { 1: slot("./devices/counter.ts"), 2: slot("./devices/probe.ts") } },
      { baseDir: app.dir },
    );
    await running.call("counter.counter", "inc", undefined);
    const [counter, probe] = running.status();
    expect(await running.reload()).toEqual([]);

    await edit(app, "devices/counter.ts", '"v1"', '"v2"');
    const results = await running.reload();
    const after = (await running.call("counter.counter", "get", undefined)) as Count;
    expect(results).toEqual([
      { device: "counter", from: counter?.firmware ?? null, to: after.firmware, mode: "hot" },
    ]);
    expect(after).toMatchObject({ n: 1, version: "v2" });
    expect(running.status()[1]?.firmware).toBe(probe?.firmware as string);
  });

  // @decision .agents/decisions/261112_035943-hot-swap.md#firmware
  test("editing a shared file swaps every device that bundles it", async () => {
    const app = await fixtureApp();
    const { running } = await startRack(
      { slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") } },
      { baseDir: app.dir },
    );
    await edit(
      app,
      "connectors.ts",
      "pinged: event(",
      "touched: event(v.object({})),\n  pinged: event(",
    );
    const results = await running.reload();
    expect(results.map((r) => [r.device, r.error])).toEqual([
      ["probe", undefined],
      ["relay", undefined],
    ]);
  });

  test("reports a device that fails to build and still swaps the others", async () => {
    const app = await fixtureApp();
    const { running } = await startRack(
      { slots: { 1: slot("./devices/counter.ts"), 2: slot("./devices/lifecycle.ts") } },
      { baseDir: app.dir },
    );
    await edit(app, "devices/counter.ts", "let n = 0;", "let n = ;");
    await edit(app, "devices/lifecycle.ts", "let ticks = 0;", "let ticks = 1;");
    const results = await running.reload();
    expect(results.map((r) => [r.device, r.to === null, r.error?.code])).toEqual([
      ["counter", true, "RACK_SWAP_REJECTED"],
      ["lifecycle", false, undefined],
    ]);
    expect(running.status()[0]?.state).toBe("degraded");
    expect(await running.call("counter.counter", "inc", undefined)).toBe(1);
  });
});
