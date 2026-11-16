/**
 * Tests for `rack.metrics()`: the call and event counters that README.md documents under
 * "Running a rack".
 *
 * @decision .agents/decisions/261116_035534-call-metrics.md#counters
 * @decision .agents/decisions/261116_035534-call-metrics.md#reading
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type DeviceMetrics, type RackHandle, slot } from "rack42u";
import { FIXTURES, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

async function pair() {
  const { running } = await startRack({
    slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") },
  });
  const relay = (member: string, input: unknown, extra: object = {}) =>
    running.call("relay.relay", "call", { member, input, ...extra });
  return { running, relay };
}

async function device(running: RackHandle, name: string): Promise<DeviceMetrics> {
  const found = (await running.metrics()).devices.find((d) => d.device === name);
  if (found === undefined) throw new Error(`no metrics for ${name}`);
  return found;
}

describe("rack.metrics()", () => {
  test("README.md: counts the calls each device served and made, with errors by code", async () => {
    const { running, relay } = await pair();
    await relay("double", 21);
    await relay("fail", { code: "ORDER_NOT_FOUND", message: "no order 7" });
    await running.call("probe.probe", "echo", 1);
    const metrics = await running.metrics();
    expect(metrics.devices.map((d): [string, string | null] => [d.device, d.firmware])).toEqual(
      running.status().map((s): [string, string | null] => [s.name, s.firmware]),
    );
    const [probe, relayed] = metrics.devices as [DeviceMetrics, DeviceMetrics];
    expect(probe.provides.probe?.double).toMatchObject({
      kind: "rpc",
      calls: 1,
      ok: 1,
      errors: {},
      active: 0,
    });
    expect(probe.provides.probe?.fail).toMatchObject({
      calls: 1,
      ok: 0,
      errors: { ORDER_NOT_FOUND: 1 },
    });
    // Calls from outside the rack count among the calls served.
    expect(probe.provides.probe?.echo).toMatchObject({ calls: 1, ok: 1 });
    expect(relayed.needs.target?.double).toMatchObject({
      kind: "rpc",
      calls: 1,
      ok: 1,
      errors: {},
      pending: 0,
      queued: 0,
    });
    expect(relayed.needs.target?.fail).toMatchObject({ calls: 1, errors: { ORDER_NOT_FOUND: 1 } });
    expect(relayed.provides.relay?.call).toMatchObject({ calls: 2, ok: 2 });
    const served = probe.provides.probe?.double;
    const made = relayed.needs.target?.double;
    expect(served?.kind === "rpc" && served.timeMs > 0).toBe(true);
    expect(made?.kind === "rpc" && made.timeMs > 0).toBe(true);
  });

  test("README.md: timeouts and cancellations count as errors of the calls made", async () => {
    const { running, relay } = await pair();
    await relay("wait", { ms: 5_000 }, { timeout: 50 });
    await relay("wait", { ms: 5_000 }, { cancelAfter: 30 });
    const wait = (await device(running, "relay")).needs.target?.wait;
    expect(wait).toMatchObject({
      calls: 2,
      ok: 0,
      errors: { RACK_TIMEOUT: 1, RACK_CANCELLED: 1 },
      pending: 0,
    });
  });

  test("README.md: active and pending count calls in flight, which status() counts as well", async () => {
    const { running, relay } = await pair();
    const pending = relay("wait", { ms: 300 });
    const probe = await waitFor(async () => {
      const found = await device(running, "probe");
      const wait = found.provides.probe?.wait;
      return wait?.kind === "rpc" && wait.active === 1 && found;
    });
    expect(probe.provides.probe?.wait).toMatchObject({ calls: 1, active: 1 });
    expect((await device(running, "relay")).needs.target?.wait).toMatchObject({ pending: 1 });
    // The probe serves a call from another device, the relay one from outside the rack.
    expect(running.status().map((s) => [s.name, s.inFlight])).toEqual([
      ["probe", 1],
      ["relay", 1],
    ]);
    await pending;
    expect((await device(running, "probe")).provides.probe?.wait).toMatchObject({
      active: 0,
      ok: 1,
    });
    expect(running.status().map((s) => s.inFlight)).toEqual([0, 0]);
  });

  test("README.md: events count as emitted where they start and received where they arrive", async () => {
    const { running } = await pair();
    for (const n of [1, 2, 3]) await running.call("probe.probe", "ping", { n });
    await waitFor(async () => {
      const pinged = (await device(running, "relay")).needs.target?.pinged;
      return pinged?.kind === "event" && pinged.received === 3;
    });
    expect((await device(running, "probe")).provides.probe?.pinged).toEqual({
      kind: "event",
      emitted: 3,
      dropped: 0,
    });
    expect((await device(running, "relay")).needs.target?.pinged).toEqual({
      kind: "event",
      received: 3,
    });
  });

  test("README.md: an event emitted before the instance is installed counts as dropped", async () => {
    const app = await tempApp(["connectors.ts", "devices"], FIXTURES);
    apps.push(app);
    const source = await app.read("devices/probe.ts");
    await app.write(
      "devices/probe.ts",
      source.replace(
        "provides: { probe: Probe },",
        "provides: { probe: Probe },\n  async activate(ctx) {\n    await ctx.emit.probe.pinged({ n: 99 });\n  },",
      ),
    );
    const { running } = await startRack(
      { slots: { 1: slot("./devices/probe.ts") } },
      { baseDir: app.dir },
    );
    expect((await device(running, "probe")).provides.probe?.pinged).toMatchObject({
      emitted: 1,
      dropped: 0,
    });
    await running.swap("probe");
    expect((await device(running, "probe")).provides.probe?.pinged).toMatchObject({
      emitted: 1,
      dropped: 1,
    });
  });

  test("README.md: calls from the HTTP panel count among the calls served", async () => {
    const { running, rec } = await startRack({
      slots: { 1: slot("./devices/web.ts") },
      panel: { http: { port: 0, routes: { "/web/*": "web.http" } } },
    });
    const response = await fetch(new URL("/web/greeting", rec.panelUrl()));
    expect(await response.text()).toBe("hello");
    expect((await device(running, "web")).provides.http?.handle).toMatchObject({
      kind: "rpc",
      calls: 1,
      ok: 1,
    });
  });

  test("README.md: counters restart when a device swaps or resets", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await running.call("probe.probe", "echo", 1);
    const before = await device(running, "probe");
    expect(before.provides.probe?.echo).toMatchObject({ calls: 1 });
    await running.swap("probe");
    const swapped = await device(running, "probe");
    expect(swapped.since).toBeGreaterThanOrEqual(before.since);
    expect(swapped.provides.probe?.echo).toMatchObject({ calls: 0, ok: 0 });

    await running.call("probe.probe", "echo", 1);
    await running.call("probe.probe", "crash", "exit").catch(() => undefined);
    await waitFor(() => rec.events.filter((e) => e.type === "fault").length === 1);
    await waitFor(() => running.status()[0]?.state === "online");
    expect((await device(running, "probe")).provides.probe?.echo).toMatchObject({ calls: 0 });
  });

  test("README.md: a device that does not answer within hookTimeout is left out", async () => {
    const { running } = await startRack(
      {
        slots: {
          1: slot("./devices/probe.ts"),
          2: slot("./devices/counter.ts"),
          3: slot("./devices/pump.ts"),
        },
      },
      { hookTimeout: 500 },
    );
    const spinning = running.call("pump.pump", "spin", { ms: 1_500 });
    await Bun.sleep(20);
    const metrics = await running.metrics();
    expect(metrics.devices.map((d) => d.device)).toEqual(["probe", "counter"]);
    await spinning;
    expect((await running.metrics()).devices.map((d) => d.device)).toEqual([
      "probe",
      "counter",
      "pump",
    ]);
  });

  test("README.md: resolves with no devices after stop()", async () => {
    const { running } = await pair();
    await running.stop();
    expect(await running.metrics()).toEqual({ devices: [] });
  });
});
