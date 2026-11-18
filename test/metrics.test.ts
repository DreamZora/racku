/**
 * Tests for `rack.metrics()`: the call and event counters that README.md documents under
 * "Running a rack".
 *
 * @decision .agents/decisions/261116_035534-call-metrics.md#counters
 * @decision .agents/decisions/261116_035534-call-metrics.md#reading
 * @decision .agents/decisions/261117_185225-outside-call-metrics.md#decision
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type DeviceMetrics, type RackHandle, slot } from "rack42u";
import { errorOf, FIXTURES, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";

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
    // The rack counts them as calls from outside the rack too, under the port the route names.
    expect((await running.metrics()).outside.ports["web.http"]?.handle).toMatchObject({
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

  test("README.md: resolves with no devices and no counters of calls from outside the rack after stop()", async () => {
    const { running } = await pair();
    await running.call("probe.probe", "echo", 1);
    await running.stop();
    expect(await running.metrics()).toEqual({ devices: [], outside: { ports: {}, unrouted: 0 } });
  });
});

/** A cold device whose new instance takes `ms` milliseconds in selfTest. */
function cold(ms: number): string {
  return `import { connector, device, rpc } from "rack42u";
import * as v from "valibot";

const Cold = connector("demo.cold/v1", { echo: rpc(v.number(), v.number()) });

export default device({
  model: "cold",
  swap: "cold",
  provides: { cold: Cold },
  powerOn: () => ({ cold: { echo: (n) => n } }),
  async selfTest() {
    await Bun.sleep(${ms});
  },
});
`;
}

describe("calls from outside the rack", () => {
  // README.md, "Running a rack".
  test("README.md: metrics().outside counts the calls from outside the rack by port and member", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await running.call("probe.probe", "echo", 1);
    const failure = { code: "ORDER_NOT_FOUND", message: "no order 7" };
    await running.call("probe.probe", "fail", failure).catch(() => undefined);
    const waiting = running.call("probe.probe", "wait", { ms: 300 });
    await Bun.sleep(50);
    expect((await running.metrics()).outside.ports["probe.probe"]?.wait).toEqual({
      kind: "rpc",
      calls: 1,
      ok: 0,
      errors: {},
      pending: 1,
      queued: 0,
      timeMs: 0,
    });
    await waiting;
    const { outside } = await running.metrics();
    const finished = (ok: number, errors: Record<string, number>) => ({
      kind: "rpc" as const,
      calls: 1,
      ok,
      errors,
      pending: 0,
      queued: 0,
      timeMs: expect.any(Number),
    });
    expect(outside).toEqual({
      ports: {
        "probe.probe": {
          echo: finished(1, {}),
          fail: finished(0, { ORDER_NOT_FOUND: 1 }),
          wait: finished(1, {}),
        },
      },
      unrouted: 0,
    });
    expect(outside.ports["probe.probe"]?.wait?.timeMs).toBeGreaterThanOrEqual(290);
  });

  test("README.md: a call from outside the rack refused at queueLimit counts under RACK_OVERLOADED", async () => {
    const { running } = await startRack(
      { slots: { 1: slot("./devices/probe.ts") } },
      { queueLimit: 1 },
    );
    const waiting = running.call("probe.probe", "wait", { ms: 200 });
    expect((await errorOf(running.call("probe.probe", "echo", 1))).code).toBe("RACK_OVERLOADED");
    await waiting;
    expect((await running.metrics()).outside.ports["probe.probe"]?.echo).toMatchObject({
      calls: 1,
      ok: 0,
      errors: { RACK_OVERLOADED: 1 },
      pending: 0,
    });
  });

  test("README.md: calls held while their device swaps count in queued, and under RACK_TIMEOUT once their deadline passes", async () => {
    const app = await tempApp();
    apps.push(app);
    await app.write("devices/cold.ts", cold(800));
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/cold.ts") } },
      { baseDir: app.dir },
    );
    const swap = running.swap("cold");
    // The old instance is off, and the new one is in selfTest: calls to the device are held.
    await waitFor(
      () => rec.events.some((event) => event.type === "power" && event.state === "off"),
      5_000,
    );
    const held = errorOf(running.call("cold.cold", "echo", 1, { timeout: 300 }));
    const resumed = running.call("cold.cold", "echo", 2);
    await Bun.sleep(100);
    const echo = async () => (await running.metrics()).outside.ports["cold.cold"]?.echo;
    expect(await echo()).toMatchObject({ calls: 2, pending: 2, queued: 2 });
    expect((await held).code).toBe("RACK_TIMEOUT");
    expect(await echo()).toMatchObject({
      calls: 2,
      ok: 0,
      errors: { RACK_TIMEOUT: 1 },
      pending: 1,
      queued: 1,
    });
    // The other one goes to the new instance once it is installed.
    await swap;
    expect(await resumed).toBe(2);
    expect(await echo()).toMatchObject({
      calls: 2,
      ok: 1,
      errors: { RACK_TIMEOUT: 1 },
      pending: 0,
      queued: 0,
    });
  });

  test("README.md: a swap that removes a member drops the member's counters", async () => {
    const app = await tempApp();
    apps.push(app);
    const two = (members: string[]) => `import { connector, device, rpc } from "rack42u";
import * as v from "valibot";

const Two = connector("demo.two/v1", {
${members.map((member) => `  ${member}: rpc(v.number(), v.number()),`).join("\n")}
});

export default device({
  model: "two",
  provides: { two: Two },
  powerOn: () => ({ two: { ${members.map((member) => `${member}: (n: number) => n`).join(", ")} } }),
});
`;
    await app.write("devices/two.ts", two(["a", "b"]));
    const { running } = await startRack(
      { slots: { 1: slot("./devices/two.ts") } },
      { baseDir: app.dir },
    );
    await running.call("two.two", "a", 1);
    await running.call("two.two", "b", 1);
    expect(Object.keys((await running.metrics()).outside.ports["two.two"] ?? {})).toEqual([
      "a",
      "b",
    ]);
    await app.write("devices/two.ts", two(["a"]));
    await running.swap("two");
    expect((await running.metrics()).outside.ports["two.two"]).toEqual({
      a: expect.objectContaining({ calls: 1, ok: 1 }),
    });
  });

  test("README.md: a call to a faulted device counts under RACK_LINK_DOWN, and calls to no address or member count in unrouted", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    // A fourth crash within the window leaves the device faulted.
    for (let crash = 0; crash < 4; crash++) {
      await running.call("probe.probe", "crash", "exit").catch(() => undefined);
      await waitFor(() => ["online", "faulted"].includes(running.status()[0]?.state ?? ""));
    }
    expect(running.status()[0]?.state).toBe("faulted");
    expect((await errorOf(running.call("probe.probe", "echo", 1))).code).toBe("RACK_LINK_DOWN");
    for (const [address, member] of [
      ["nowhere.port", "echo"],
      ["probe.probe", "nothing"],
      ["not an address", "echo"],
    ] as const) {
      expect((await errorOf(running.call(address, member, 1))).code).toBe("RACK_NO_ROUTE");
    }
    const { outside } = await running.metrics();
    expect(outside.ports["probe.probe"]?.echo).toMatchObject({
      calls: 1,
      ok: 0,
      errors: { RACK_LINK_DOWN: 1 },
    });
    expect(outside.ports["probe.probe"]?.crash).toMatchObject({
      calls: 4,
      errors: { RACK_DEVICE_FAULT: 4 },
    });
    expect(Object.keys(outside.ports)).toEqual(["probe.probe"]);
    expect(outside.unrouted).toBe(3);
  });

  test("README.md: the counters of calls from outside the rack last across swaps, and go away when the device is unplugged", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await running.call("probe.probe", "echo", 1);
    await running.swap("probe");
    const swapped = await running.metrics();
    expect(swapped.outside.ports["probe.probe"]?.echo).toMatchObject({ calls: 1, ok: 1 });
    // The device's own counters restarted with its new instance.
    expect(swapped.devices[0]?.provides.probe?.echo).toMatchObject({ calls: 0 });
    await running.unplug("probe");
    expect((await running.metrics()).outside).toEqual({ ports: {}, unrouted: 0 });
  });
});
