/**
 * Tests for links: calls and events between devices travel directly between their Workers, and
 * the backplane holds and switches the links when instances change.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#links
 * @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type RackEvent, slot } from "rack42u";
import {
  codeOf,
  FIXTURES,
  type Recorder,
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

/** A temporary app holding a copy of the fixture devices, with one device file edited. */
async function editedApp(path: string, from: string, to: string): Promise<TempApp> {
  const app = await tempApp(["connectors.ts", "devices"], FIXTURES);
  apps.push(app);
  const text = await app.read(path);
  if (!text.includes(from)) throw new Error(`${path} does not contain ${from}`);
  await app.write(path, text.replace(from, to));
  return app;
}

function count(rec: Recorder, match: (event: RackEvent) => boolean): number {
  return rec.events.filter(match).length;
}

const poweredOn = (event: RackEvent) => event.type === "power" && event.state === "on";

interface Relayed {
  ok: boolean;
  value: unknown;
  code?: string;
}

const PUMP_RACK = {
  slots: {
    1: slot("./devices/probe.ts"),
    2: slot("./devices/counter.ts"),
    3: slot("./devices/pump.ts"),
  },
};

describe("links", () => {
  // @doc docs/concepts.md#the-backplane-and-links
  // Calls and events between devices travel on links, Worker to Worker.
  // @decision .agents/decisions/261116_024226-backplane-links.md#links
  test("calls between devices complete while the rack main thread is blocked", async () => {
    const { running } = await startRack(PUMP_RACK);
    // Taken before the call: the main thread relays nothing from here until the loop ends, and
    // the device may start the moment the call goes out.
    const blockedAt = Date.now();
    const burst = running.call("pump.pump", "burst", { n: 100 }) as Promise<{
      startedAt: number;
      finishedAt: number;
    }>;
    while (Date.now() - blockedAt < 300) {
      // Busy-wait: the main thread cannot relay anything until the loop ends.
    }
    const releasedAt = Date.now();
    const { startedAt, finishedAt } = await burst;
    expect(startedAt).toBeGreaterThanOrEqual(blockedAt);
    expect(finishedAt).toBeLessThan(releasedAt);
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#events
  test("events between devices arrive while the rack main thread is blocked", async () => {
    const { running } = await startRack(PUMP_RACK);
    // Taken before the call, as above.
    const blockedAt = Date.now();
    const ping = running.call("probe.probe", "ping", { n: 1 });
    while (Date.now() - blockedAt < 300) {
      // Busy-wait: the main thread cannot relay anything until the loop ends.
    }
    const releasedAt = Date.now();
    await ping;
    const arrivals = await waitFor(async () => {
      const list = (await running.call("pump.pump", "pings", undefined)) as number[];
      return list.length > 0 && list;
    });
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0] as number).toBeGreaterThanOrEqual(blockedAt);
    expect(arrivals[0] as number).toBeLessThan(releasedAt);
  });

  // @doc docs/guides/updates.md#the-swap-sequence
  // Step 4: held calls go to the new instance.
  // @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
  test("calls between devices during a swap without state handover all succeed", async () => {
    const { running } = await startRack(PUMP_RACK);
    const burst = running.call("pump.pump", "burst", { n: 3_000 });
    await Bun.sleep(5);
    await running.swap("probe");
    expect(await burst).toMatchObject({ startedAt: expect.any(Number) });
  });

  // @doc docs/reference/reports.md#metrics
  // `queued` counts calls waiting while the provider is swapped.
  // @decision .agents/decisions/261116_024226-backplane-links.md#in-flight-calls-holding-and-draining
  test("a held slot gets no call until the switch, and the queued calls then arrive in order", async () => {
    const { running } = await startRack(PUMP_RACK);
    // A slow call keeps the old instance draining, so the hold lasts until it ends.
    const slowMs = 300;
    const slowSentAt = performance.now();
    const slow = running.call("counter.counter", "slowInc", slowMs);
    await Bun.sleep(20);
    const pumped = running.call("pump.pump", "incs", { n: 100, gapMs: 5 }) as Promise<{
      values: number[];
      maxMs: number;
    }>;
    await Bun.sleep(20);
    const swapped = running.swap("counter");
    const queued = await waitFor(async () => {
      const pump = (await running.metrics()).devices.find((d) => d.device === "pump");
      const inc = pump?.needs.counter?.inc;
      return inc?.kind === "rpc" && inc.queued > 0 && inc.queued;
    });
    const queuedAt = performance.now();
    expect(queued).toBeGreaterThan(0);
    await swapped;
    const { values, maxMs } = await pumped;
    expect(typeof (await slow)).toBe("number");
    // Strictly increasing: no call was lost or reordered, and none reached the old instance
    // after its snapshot.
    for (let i = 1; i < values.length; i++) {
      expect(values[i] as number).toBeGreaterThan(values[i - 1] as number);
    }
    expect(await running.call("counter.counter", "get", undefined)).toMatchObject({ n: 101 });
    // A call that the metrics found queued was sent before queuedAt, and is answered only after
    // the slow call ends, slowMs after it was sent at the earliest. The bound is measured, since
    // when the hold begins depends on how long the new instance takes to start; 5 ms allow for
    // the granularity of timers.
    expect(maxMs).toBeGreaterThan(slowSentAt + slowMs - queuedAt - 5);
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#faults-and-resets
  test("calls pending on a link fail when the provider crashes, and the need relinks after the reset", async () => {
    const { running, rec } = await startRack({
      slots: {
        1: slot("./devices/probe.ts", { config: { powerOnDelayMs: 300 } }),
        3: slot("./devices/relay.ts"),
      },
    });
    const relay = (member: string, input: unknown) =>
      running.call("relay.relay", "call", { member, input }) as Promise<Relayed>;
    const pending = relay("wait", { ms: 5_000 });
    await Bun.sleep(20);
    await running.call("probe.probe", "crash", "exit").catch(() => undefined);
    expect(await pending).toMatchObject({ ok: false, code: "RACK_DEVICE_FAULT" });
    await waitFor(() => running.status()[0]?.state === "resetting");
    expect(await relay("double", 2)).toMatchObject({ ok: false, code: "RACK_LINK_DOWN" });
    await waitFor(() => count(rec, poweredOn) === 1);
    expect(await relay("double", 2)).toEqual({ ok: true, value: 4 });
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#events
  test("an instance in standby receives no events", async () => {
    const app = await editedApp(
      "devices/relay.ts",
      "provides: { relay: Relay },",
      'provides: { relay: Relay },\n  async selfTest(ctx) {\n    ctx.log.info("relay standing by");\n    await Bun.sleep(400);\n  },',
    );
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") } },
      { baseDir: app.dir },
    );
    await running.call("probe.probe", "ping", { n: 1 });
    const swapped = running.swap("relay");
    await waitFor(() => rec.logs.filter((e) => e.message === "relay standing by").length === 2);
    // The new instance subscribed in powerOn but is still in standby: the event goes to the old one.
    await running.call("probe.probe", "ping", { n: 2 });
    await swapped;
    await running.call("probe.probe", "ping", { n: 3 });
    const received = await waitFor(async () => {
      const list = (await running.call("relay.relay", "received", undefined)) as number[];
      return list.length > 0 && list;
    });
    expect(received).toEqual([3]);
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#events
  test("events an instance emits before it is installed are dropped with a warning", async () => {
    const app = await editedApp(
      "devices/probe.ts",
      "provides: { probe: Probe },",
      "provides: { probe: Probe },\n  async activate(ctx) {\n    await ctx.emit.probe.pinged({ n: 99 });\n  },",
    );
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/probe.ts") } },
      { baseDir: app.dir },
    );
    const dropped = () =>
      rec.logs.filter(
        (e) => e.device === "probe" && e.message.startsWith("dropped event probe.pinged"),
      );
    expect(dropped()).toHaveLength(0);
    await running.swap("probe");
    expect(dropped()).toHaveLength(1);
  });
});

/** Starts Workers with `RACK42U_TEST_CRASH_AFTER_ACTIVATE_MS` set while `body` runs. */
async function crashingAfterActivate<T>(ms: number, body: () => Promise<T>): Promise<T> {
  process.env.RACK42U_TEST_CRASH_AFTER_ACTIVATE_MS = String(ms);
  try {
    return await body();
  } finally {
    delete process.env.RACK42U_TEST_CRASH_AFTER_ACTIVATE_MS;
  }
}

const BUSY_RACK = (activateDelayMs?: number) => ({
  slots: {
    1: slot("./devices/busy.ts", {
      config: activateDelayMs === undefined ? {} : { activateDelayMs },
    }),
    3: slot("./devices/client.ts"),
  },
});

const activations = (rec: Recorder) =>
  rec.logs.filter((e) => e.message === "busy activating").length;

describe("links through crashes and busy instances", () => {
  // @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
  test("a consumer that resets during a swap of its provider ends up linked to the new instance", async () => {
    const { running, rec } = await startRack(BUSY_RACK(600));
    const before = (await running.call("client.client", "call", {})) as { by: string };
    const swapped = running.swap("busy");
    await waitFor(() => activations(rec) === 2);
    // The old instance is busy while the consumer's reset links to it.
    const spinning = running.call("busy.busy", "spin", { ms: 1_500 });
    await running.call("client.client", "crash", undefined);
    await spinning;
    await swapped;
    await waitFor(() => running.status()[1]?.state === "online");
    const now = await running.call("busy.busy", "whoami", undefined);
    expect(now).not.toBe(before.by);
    expect(await running.call("client.client", "call", { timeout: 1_000 })).toEqual({
      ok: true,
      by: now,
    });
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
  test("a new instance that exits while the swap holds the slot is rolled back", async () => {
    const { running, rec } = await startRack(BUSY_RACK(300));
    const old = await running.call("busy.busy", "whoami", undefined);
    await crashingAfterActivate(50, async () => {
      const swapped = running.swap("busy");
      await waitFor(() => activations(rec) === 2);
      // A busy consumer keeps the hold waiting until after the new instance has exited.
      const spinning = running.call("client.client", "spin", { ms: 600 });
      expect(await codeOf(swapped)).toBe("RACK_SWAP_REJECTED");
      await spinning;
    });
    expect(running.status()[0]).toMatchObject({ state: "degraded", crashes: 0 });
    expect(await running.call("busy.busy", "whoami", undefined)).toBe(old);
    expect(await running.call("client.client", "call", { timeout: 1_000 })).toEqual({
      ok: true,
      by: old,
    });
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#faults-and-resets
  test("an instance that exits while its reset installs it is reset again, up to the crash limit", async () => {
    const { running } = await startRack(BUSY_RACK());
    await crashingAfterActivate(20, async () => {
      // A busy consumer keeps the install of the first reset waiting until it has exited.
      const spinning = running.call("client.client", "spin", { ms: 400 });
      await running.call("busy.busy", "crash", undefined);
      await spinning;
      await waitFor(() => running.status()[0]?.state === "faulted");
    });
    expect(running.status()[0]).toMatchObject({ state: "faulted", firmware: null, crashes: 4 });
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
  test("a link that reaches a busy consumer after its request timed out still takes effect", async () => {
    const { running } = await startRack(BUSY_RACK(), { hookTimeout: 500 });
    const spinning = running.call("client.client", "spin", { ms: 1_500 });
    await Bun.sleep(20);
    await running.swap("busy");
    await spinning;
    const now = await running.call("busy.busy", "whoami", undefined);
    expect(await running.call("client.client", "call", { timeout: 1_000 })).toEqual({
      ok: true,
      by: now,
    });
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#events
  test("events held for a swap that rolled back never reach a later instance", async () => {
    const app = await tempApp(["connectors.ts", "devices"], FIXTURES);
    apps.push(app);
    const watch = (
      needs: boolean,
      restore: string,
    ) => `import { connector, device, rpc } from "rack42u";
import * as v from "valibot";
import { Probe } from "../connectors.ts";

const Watch = connector("test.watch/v1", { received: rpc(v.undefined(), v.array(v.number())) });
const got: number[] = [];

export default device({
  model: "watch",
  ${needs ? "needs: { probe: Probe }," : ""}
  provides: { watch: Watch },
  powerOn(ctx) {
    ${needs ? "ctx.on.probe.pinged(({ n }) => { got.push(n); });" : "void ctx;"}
    return { watch: { received: () => [...got] } };
  },
  snapshot: () => ({}),
  async restore(ctx) {
    ${restore}
  },
});
`;
    await app.write("devices/watch.ts", watch(false, ""));
    await app.write(
      "devices/watch-fails.ts",
      watch(true, 'ctx.log.info("restoring"); await Bun.sleep(300); throw new Error("no");'),
    );
    await app.write("devices/watch-ok.ts", watch(true, ""));
    const { running, rec } = await startRack(
      { slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/watch.ts") } },
      { baseDir: app.dir },
    );
    const failed = running.swap("watch", "./devices/watch-fails.ts");
    await waitFor(() => rec.logs.some((e) => e.message === "restoring"));
    // Emitted while the slot is held for a handover that will roll back.
    await running.call("probe.probe", "ping", { n: 1 });
    await running.call("probe.probe", "ping", { n: 2 });
    expect(await codeOf(failed)).toBe("RACK_HOOK_FAILED");
    await running.swap("watch", "./devices/watch-ok.ts");
    await running.call("probe.probe", "ping", { n: 3 });
    const received = await waitFor(async () => {
      const list = (await running.call("watch.watch", "received", undefined)) as number[];
      return list.length > 0 && list;
    });
    expect(received).toEqual([3]);
  });
});
