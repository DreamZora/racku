/**
 * Tests for crash detection and automatic resets.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#faults-and-resets
 * @decision .agents/decisions/261115_222025-p0-api-details.md#resets
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type RackEvent, type RackHandle, slot } from "rack42u";
import { codeOf, type Recorder, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

function count(rec: Recorder, match: (event: RackEvent) => boolean): number {
  return rec.events.filter(match).length;
}

const poweredOn = (event: RackEvent) => event.type === "power" && event.state === "on";

/** Makes the probe crash; a crash by exit also fails the call that caused it. */
async function crash(running: RackHandle, kind: "reject" | "throw" | "exit"): Promise<void> {
  await running.call("probe.probe", "crash", kind).catch(() => undefined);
}

// @doc docs/guides/faults.md#crashes
describe("crash resets", () => {
  test.each(["reject", "throw", "exit"] as const)(
    "a crash by %s resets the device from the same firmware",
    async (kind) => {
      const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
      const firmware = running.status()[0]?.firmware;
      await crash(running, kind);
      await waitFor(() => count(rec, poweredOn) === 1);
      const fault = rec.events.find((e) => e.type === "fault");
      expect(fault).toMatchObject({
        type: "fault",
        device: "probe",
        firmware,
        reset: true,
        error: { code: "RACK_DEVICE_FAULT" },
      });
      expect(running.status()[0]).toMatchObject({ state: "online", firmware, crashes: 1 });
      expect(await running.call("probe.probe", "echo", "back")).toBe("back");
    },
  );

  test("calls in flight on a crashed instance fail with RACK_DEVICE_FAULT", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    const inFlight = codeOf(running.call("probe.probe", "wait", { ms: 5_000 }));
    await Bun.sleep(20);
    await crash(running, "exit");
    expect(await inFlight).toBe("RACK_DEVICE_FAULT");
    await waitFor(() => count(rec, poweredOn) === 1);
  });

  test("a reset does not keep in-memory state", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await codeOf(running.call("probe.probe", "wait", { ms: 5_000 }, { timeout: 20 }));
    await waitFor(
      async () =>
        ((await running.call("probe.probe", "aborts", undefined)) as string[]).length === 1,
    );
    await crash(running, "exit");
    await waitFor(() => count(rec, poweredOn) === 1);
    expect(await running.call("probe.probe", "aborts", undefined)).toEqual([]);
  });

  test("calls during a reset fail with RACK_LINK_DOWN", async () => {
    const { running, rec } = await startRack({
      slots: { 1: slot("./devices/probe.ts", { config: { powerOnDelayMs: 300 } }) },
    });
    await crash(running, "exit");
    await waitFor(() => running.status()[0]?.state === "resetting");
    expect(await codeOf(running.call("probe.probe", "echo", 1))).toBe("RACK_LINK_DOWN");
    await waitFor(() => count(rec, poweredOn) === 1);
    expect(await running.call("probe.probe", "echo", 1)).toBe(1);
  });

  // @doc docs/reference/limits.md#supervision-and-history
  // @doc docs/reference/reports.md#status
  test("more than 3 crashes within 60 seconds mark the slot faulted until a swap succeeds", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    for (let n = 1; n <= 3; n++) {
      await crash(running, "exit");
      await waitFor(() => count(rec, poweredOn) === n);
    }
    await crash(running, "exit");
    await waitFor(() => running.status()[0]?.state === "faulted");
    expect(
      rec.events.filter((e) => e.type === "fault").map((e) => e.type === "fault" && e.reset),
    ).toEqual([true, true, true, false]);
    expect(running.status()[0]).toMatchObject({ firmware: null, crashes: 4 });
    expect(await codeOf(running.call("probe.probe", "echo", 1))).toBe("RACK_LINK_DOWN");

    await running.swap("probe");
    expect(running.status()[0]).toMatchObject({ state: "online", crashes: 0 });
    expect(await running.call("probe.probe", "echo", 1)).toBe(1);
  });

  test("the crash log points into the device source through the inline source map", async () => {
    const { running, rec } = await startRack({ slots: { 1: slot("./devices/probe.ts") } });
    await crash(running, "throw");
    await waitFor(() => count(rec, poweredOn) === 1);
    const entry = rec.logs.find((e) => e.message.startsWith("probe crashed"));
    expect(entry?.message).toContain("thrown on purpose");
    // With the system's separator, \ on Windows.
    // @decision .agents/decisions/261118_015204-windows.md#differences-the-readme-states
    expect(entry?.message).toContain(join("devices", "probe.ts"));
  });
});
