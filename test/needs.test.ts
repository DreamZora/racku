/**
 * Tests for needs that a device computes from its configuration, and for needs that `patched()`
 * wires to an address: README.md, "Needs from configuration".
 *
 * @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
 */
import { afterEach, describe, expect, test } from "bun:test";
import { device, patched, RackError, type RackHandle, rack, slot } from "rack42u";
import { errorOf, FIXTURES, type TempApp, tempApp, useRacks } from "./fixtures/app.ts";
import { Probe } from "./fixtures/connectors.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const A = slot("./devices/probe.ts", { name: "a" });
const B = slot("./devices/probe.ts", { name: "b" });
const picker = (config: Record<string, unknown>) => slot("./devices/picker.ts", { config });
const names = (running: RackHandle) => running.call("picker.picker", "names", undefined);

// @doc docs/guides/devices.md#needs-from-configuration
describe("needs from configuration", () => {
  test("a device's needs can come from its configuration, and patched() wires each to its address", async () => {
    const { running } = await startRack({
      slots: { 1: A, 2: B, 3: picker({ targets: ["b", "a"] }) },
    });
    expect(await names(running)).toEqual({ a: "a", b: "b" });
  });

  test("needs from configuration without patched() are wired as any need", async () => {
    const plain = picker({ targets: ["x"], wire: false });
    const ambiguous = await errorOf(startRack({ slots: { 1: A, 2: B, 3: plain } }));
    expect(ambiguous.message).toContain("picker.x (test.probe/v1) is ambiguous: a.probe, b.probe");
    const { running } = await startRack({ slots: { 1: A, 3: plain } });
    expect(await names(running)).toEqual({ x: "a" });
  });

  test("a patch in the manifest wins over patched()", async () => {
    const { running } = await startRack({
      slots: { 1: A, 2: B, 3: picker({ targets: ["a"] }) },
      patch: [["picker.a", "b.probe"]],
    });
    expect(await names(running)).toEqual({ a: "b" });
  });

  test("a reload with new configuration wires the needs the device computes from it", async () => {
    const placed = (targets: string[]) => ({ slots: { 1: A, 2: B, 3: picker({ targets }) } });
    const { running } = await startRack(placed(["a"]));
    expect(await names(running)).toEqual({ a: "a" });
    const results = await running.reload(rack("test", placed(["a", "b"])));
    expect(results.map((result) => [result.device, result.error])).toEqual([["picker", undefined]]);
    expect(await names(running)).toEqual({ a: "a", b: "b" });
  });

  test("a needs function that throws, or returns something that isn't needs, fails with RACK_INVALID_CONFIG", async () => {
    const thrown = await errorOf(startRack({ slots: { 1: picker({ fail: true }) } }));
    expect(thrown.code).toBe("RACK_INVALID_CONFIG");
    expect(thrown.message).toContain("no needs today");
    const bad = await errorOf(startRack({ slots: { 1: picker({ bad: true }) } }));
    expect(bad.code).toBe("RACK_INVALID_CONFIG");
    expect(bad.message).toContain("needs.x");
  });

  test("in a scanned rack, patched() pulls in the model its address names, unless a use entry for the need picks another", async () => {
    const app = await tempApp(["connectors.ts", "devices/probe.ts", "devices/picker.ts"], FIXTURES);
    apps.push(app);
    const scanned = (use: Record<string, string>) =>
      startRack(
        {
          devices: ["./devices", slot("./devices/probe.ts", { name: "other" })],
          roots: ["picker"],
          config: { picker: { targets: ["other"] } },
          use,
        },
        { baseDir: app.dir, plan: false },
      );
    const pulled = await scanned({});
    expect(pulled.running.status().map((s) => s.name)).toEqual(["other", "picker"]);
    expect(await names(pulled.running)).toEqual({ other: "other" });
    // A use entry keyed by the connector id doesn't change a need that patched() wires.
    const byConnector = await scanned({ "test.probe/v1": "probe" });
    expect(await names(byConnector.running)).toEqual({ other: "other" });
    const byNeed = await scanned({ "picker.other": "probe" });
    expect(await names(byNeed.running)).toEqual({ other: "probe" });
  });

  test("patched() takes a <device>.<port> address", () => {
    expect(patched(Probe, "a.probe")).toMatchObject({ connector: Probe, address: "a.probe" });
    for (const address of ["a", "a.b.c", ".probe", "a."]) {
      expect(() => patched(Probe, address)).toThrow(RackError);
    }
  });

  test("device() keeps a needs function for boot, and declares no needs of its own", () => {
    const def = device({ model: "m", needs: () => ({ p: Probe }) });
    expect(Object.keys(def.needs)).toEqual([]);
    expect(def.needsOf?.(undefined)).toEqual({ p: Probe });
  });
});
