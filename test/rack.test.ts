/**
 * Tests for rack start-up, assembly, power sequencing, shutdown, and the device context.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#rack-runtime
 * @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rack, slot, start } from "rack42u";
import { httpPanel } from "rack42u/std";
import { codeOf, errorOf, FIXTURES, Recorder, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

describe("start and stop", () => {
  // @doc docs/concepts.md#the-gravity-rule
  test("powers devices on from the bottom up and off from the top down", async () => {
    const { running, rec } = await startRack({
      slots: {
        1: slot("./devices/lifecycle.ts", { name: "low" }),
        3: slot("./devices/lifecycle.ts", { name: "high" }),
      },
    });
    await running.stop();
    expect(rec.hooks()).toEqual([
      "low.powerOn",
      "low.selfTest",
      "low.activate",
      "high.powerOn",
      "high.selfTest",
      "high.activate",
      "high.deactivate",
      "high.powerOff",
      "low.deactivate",
      "low.powerOff",
    ]);
  });

  // @decision .agents/decisions/261115_222025-p0-api-details.md#rack-handle
  // @doc docs/reference/api.md#the-rack-handle
  // @doc docs/reference/reports.md#status
  test("status reports each device by slot", async () => {
    const { running } = await startRack({
      slots: { 5: slot("./devices/tall.ts"), 1: slot("./devices/probe.ts", { name: "p" }) },
    });
    const status = running.status();
    expect(
      status.map(({ name, model, u, height, state }) => ({ name, model, u, height, state })),
    ).toEqual([
      { name: "p", model: "probe", u: 1, height: 1, state: "online" },
      { name: "tall", model: "tall", u: 5, height: 3, state: "online" },
    ]);
    expect(status[0]?.firmware).toMatch(/^[a-z0-9]+$/);
    expect(status[0]?.source).toBe(join(FIXTURES, "devices", "probe.ts"));
    expect(status[0]?.inFlight).toBe(0);
    expect(status[0]?.crashes).toBe(0);
  });

  // @decision .agents/decisions/261115_222025-p0-api-details.md#rack-handle
  // @doc docs/reference/api.md#the-rack-handle
  test("after stop, calls and management operations fail and status is empty", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await running.stop();
    await running.stop();
    expect(running.status()).toEqual([]);
    expect(await codeOf(running.call("probe.probe", "echo", 1))).toBe("RACK_LINK_DOWN");
    expect(await codeOf(running.swap("probe"))).toBe("RACK_SWAP_REJECTED");
    expect(await codeOf(running.reload())).toBe("RACK_SWAP_REJECTED");
  });

  // @doc docs/reference/api.md#start
  // @doc docs/reference/errors.md#codes
  test("a failing hook rejects start and powers off the devices already on", async () => {
    const rec = new Recorder();
    const failed = start(
      rack("test", {
        slots: {
          1: slot("./devices/lifecycle.ts", { name: "low" }),
          3: slot("./devices/lifecycle.ts", { name: "high", config: { failAt: "selfTest" } }),
        },
      }),
      { baseDir: FIXTURES, logger: rec.logger },
    );
    const error = await errorOf(failed);
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(error.message).toContain("selfTest failed on purpose");
    expect(rec.hooks()).toEqual([
      "low.powerOn",
      "low.selfTest",
      "low.activate",
      "high.powerOn",
      "high.selfTest",
      "high.powerOff",
      "low.deactivate",
      "low.powerOff",
    ]);
  });

  // @doc docs/reference/api.md#start
  test("a hook that does not finish fails after hookTimeout", async () => {
    const manifest = rack("test", {
      slots: { 1: slot("./devices/lifecycle.ts", { config: { hangAt: "activate" } }) },
    });
    const error = await errorOf(
      start(manifest, { baseDir: FIXTURES, logger: () => {}, hookTimeout: 200 }),
    );
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(error.message).toContain("activate timed out after 200 ms");
  });

  // @doc docs/guides/devices.md#the-context
  // @doc docs/reference/errors.md#codes
  test("invalid configuration fails with RACK_INVALID_CONFIG", async () => {
    const manifest = rack("test", {
      slots: { 1: slot("./devices/lifecycle.ts", { config: { failAt: "nowhere" } }) },
    });
    const error = await errorOf(start(manifest, { baseDir: FIXTURES, logger: () => {} }));
    expect(error.code).toBe("RACK_INVALID_CONFIG");
    expect(error.message).toContain("lifecycle: invalid config");
  });

  test("configuration that cannot be cloned fails with RACK_INVALID_CONFIG", async () => {
    const manifest = rack("test", {
      slots: { 1: slot("./devices/probe.ts", { config: { label: () => "x" } }) },
    });
    expect(await codeOf(start(manifest, { baseDir: FIXTURES, logger: () => {} }))).toBe(
      "RACK_INVALID_CONFIG",
    );
  });

  // @decision .agents/decisions/261115_222025-p0-api-details.md#error-codes
  test.each([
    ["does not default-export a device", "./devices/not-a-device.ts", "does not default-export"],
    ["does not exist", "./devices/missing.ts", "firmware build failed"],
    ["throws while it loads", "./devices/throws-at-load.ts", "broken at load"],
  ])("a device file that %s fails with RACK_MANIFEST", async (_label, source, text) => {
    const manifest = rack("test", { slots: { 1: slot(source) } });
    const error = await errorOf(start(manifest, { baseDir: FIXTURES, logger: () => {} }));
    expect(error.code).toBe("RACK_MANIFEST");
    expect(error.message).toContain(text);
  });

  test("start rejects a value that is not a manifest", async () => {
    expect(await codeOf(start({} as never))).toBe("RACK_MANIFEST");
  });
});

// @doc docs/guides/racks.md#placing-devices-by-hand
describe("assembly", () => {
  async function assemblyError(spec: Parameters<typeof rack>[1]): Promise<string> {
    const error = await errorOf(start(rack("test", spec), { baseDir: FIXTURES, logger: () => {} }));
    expect(error.code).toBe("RACK_MANIFEST");
    return error.message;
  }

  test("rejects overlapping devices", async () => {
    const message = await assemblyError({
      slots: { 1: slot("./devices/tall.ts"), 2: slot("./devices/probe.ts") },
    });
    expect(message).toContain("probe at U2 overlaps tall at U1-U3");
  });

  test("rejects a device that does not fit in the rack", async () => {
    const message = await assemblyError({ size: 4, slots: { 3: slot("./devices/tall.ts") } });
    expect(message).toContain("exceeds the 4U rack");
  });

  test("rejects duplicate device names", async () => {
    const message = await assemblyError({
      slots: { 1: slot("./devices/probe.ts"), 2: slot("./devices/probe.ts") },
    });
    expect(message).toContain("two devices are named probe");
  });

  // @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
  test("rejects a need that only a device above provides (gravity rule)", async () => {
    const message = await assemblyError({
      slots: { 1: slot("./devices/relay.ts"), 3: slot("./devices/probe.ts") },
    });
    expect(message).toContain("relay.target (test.probe/v1): no device below U1 provides it");
    expect(message).toContain("gravity rule");
  });

  // @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
  test("rejects an ambiguous need, and a patch resolves it", async () => {
    const slots = {
      1: slot("./devices/probe.ts", { name: "a" }),
      2: slot("./devices/probe.ts", { name: "b" }),
      3: slot("./devices/relay.ts"),
    };
    const message = await assemblyError({ slots });
    expect(message).toContain("relay.target (test.probe/v1) is ambiguous: a.probe, b.probe");

    const { running } = await startRack({ slots, patch: [["relay.target", "b.probe"]] });
    const result = await running.call("relay.relay", "call", { member: "info", input: undefined });
    expect((result as { value: { name: string } }).value.name).toBe("b");
  });

  test.each([
    [[["relay.target", "ghost.probe"]], "no device ghost"],
    [[["relay.nothing", "probe.probe"]], "no device relay with need nothing"],
    [[["probe.target", "relay.relay"]], "no device probe with need target"],
  ] as const)("rejects the patch %j", async (patch, text) => {
    const message = await assemblyError({
      slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") },
      patch,
    });
    expect(message).toContain(text);
  });

  test("rejects a patch that points upward", async () => {
    const message = await assemblyError({
      slots: {
        1: slot("./devices/probe.ts", { name: "low" }),
        2: slot("./devices/relay.ts"),
        3: slot("./devices/probe.ts", { name: "high" }),
      },
      patch: [["relay.target", "high.probe"]],
    });
    expect(message).toContain("breaks the gravity rule");
  });

  // A route is a need that patched() wires, so it fails as such a patch does.
  // @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
  // @doc docs/guides/http.md#routes
  test("rejects a panel route to a port that is not http/v2", async () => {
    const message = await assemblyError({
      slots: {
        1: slot("./devices/probe.ts"),
        2: httpPanel({ port: 0, routes: { "/x": "probe.probe" } }),
      },
    });
    expect(message).toContain(
      "patch http-panel.probe_probe (http/v2) -> probe.probe: not a http/v2 port",
    );
  });
});

describe("device context", () => {
  // @doc docs/guides/devices.md#the-context
  test("exposes the slot, firmware, base directory, and validated config", async () => {
    const { running } = await startRack({
      slots: { 4: slot("./devices/probe.ts", { name: "p", config: { label: "x" } }) },
    });
    const info = (await running.call("p.probe", "info", undefined)) as Record<string, unknown>;
    expect(info).toMatchObject({ name: "p", u: 4, baseDir: FIXTURES, config: { label: "x" } });
    expect(info.firmware).toBe(running.status()[0]?.firmware as string);
  });

  // @decision .agents/decisions/261112_043034-device-api.md#device-context
  // @doc docs/guides/devices.md#the-environment
  test("each Worker receives a copy of the environment at its creation", async () => {
    process.env.RACK42U_TEST_ENV = "copied";
    try {
      const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
      process.env.RACK42U_TEST_ENV = "changed later";
      const info = (await running.call("probe.probe", "info", undefined)) as { env: string };
      expect(info.env).toBe("copied");
    } finally {
      delete process.env.RACK42U_TEST_ENV;
    }
  });

  // @decision .agents/decisions/261112_035943-hot-swap.md#the-main-thread-never-loads-device-code
  // @doc docs/guides/racks.md#placing-devices-by-hand
  test("the rack main thread never evaluates device code", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    expect(await running.call("probe.probe", "echo", "hi")).toBe("hi");
    expect(
      (globalThis as { __rack42uDeviceLoaded?: boolean }).__rack42uDeviceLoaded,
    ).toBeUndefined();
  });

  // @decision .agents/decisions/261112_035943-hot-swap.md#lifecycle
  // @doc docs/guides/devices.md#hooks
  // @doc docs/guides/devices.md#background-work
  test("background tasks run after activate and stop before the deactivate hook", async () => {
    const { running, rec } = await startRack({
      slots: {
        1: slot("./devices/lifecycle.ts", { config: { tickMs: 5, slowDeactivateMs: 100 } }),
      },
    });
    await waitFor(
      async () => ((await running.call("lifecycle.life", "ticks", undefined)) as number) > 2,
    );
    await running.stop();
    const messages = rec.logs.filter((e) => e.device === "lifecycle").map((e) => e.message);
    const deactivate = rec.logs.findIndex(
      (e) => e.message === "hook" && (e.data as { hook: string }).hook === "deactivate",
    );
    expect(messages).toContain("tick");
    expect(rec.logs.slice(deactivate).some((e) => e.message === "tick")).toBe(false);
  });

  // @doc docs/guides/devices.md#background-work
  test("errors thrown by scope timers are logged and do not crash the device", async () => {
    const { running, rec } = await startRack({
      slots: { 1: slot("./devices/lifecycle.ts", { config: { tickMs: 5, tickThrows: true } }) },
    });
    await waitFor(() => rec.logs.some((e) => e.message.includes("tick failed on purpose")));
    expect(await running.call("lifecycle.life", "ticks", undefined)).toBeGreaterThan(0);
    expect(running.status()[0]?.crashes).toBe(0);
  });

  // @doc docs/guides/devices.md#background-work
  test("scope.after runs once, and the function it returns cancels the timer", async () => {
    const { rec } = await startRack({
      slots: { 1: slot("./devices/lifecycle.ts", { config: { afterMs: 10 } }) },
    });
    await waitFor(() => rec.logs.some((e) => e.message === "after"));
    await Bun.sleep(50);
    expect(rec.logs.filter((e) => e.message === "after")).toHaveLength(1);
    expect(rec.logs.some((e) => e.message === "cancelled timer ran")).toBe(false);
  });

  // @decision .agents/decisions/261115_222025-p0-api-details.md#device-hooks
  // @doc docs/guides/devices.md#background-work
  test("scope.signal aborts before the deactivate hook runs", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/lifecycle.ts") } });
    await running.stop();
    const messages = rec.logs
      .filter((e) => e.device === "lifecycle")
      .map((e) => (e.message === "hook" ? (e.data as { hook: string }).hook : e.message));
    expect(messages.indexOf("scope aborted")).toBeGreaterThan(messages.indexOf("activate"));
    expect(messages.indexOf("scope aborted")).toBeLessThan(messages.indexOf("deactivate"));
  });

  // @decision .agents/decisions/261115_222025-p0-api-details.md#device-hooks
  // @doc docs/guides/devices.md#the-context
  test("ctx.signal aborts after the powerOff hook", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/lifecycle.ts") } });
    await running.stop();
    const messages = rec.logs.filter((e) => e.device === "lifecycle").map((e) => e.message);
    const hooks = rec.hooks();
    expect(hooks.at(-1)).toBe("lifecycle.powerOff");
    expect(messages.at(-1)).toBe("signal aborted");
  });

  // @doc docs/guides/devices.md#the-context
  test("device logs reach the logger and subscribers with the device name", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/lifecycle.ts") } });
    const entry = rec.logs.find((e) => e.message === "hook");
    expect(entry).toMatchObject({ level: "info", device: "lifecycle", data: { hook: "powerOn" } });
    const seen: string[] = [];
    running.subscribe((event) => {
      if (event.type === "log") seen.push(event.message);
    });
    await running.stop();
    expect(seen).toContain("hook");
  });
});
