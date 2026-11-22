/**
 * Tests for binary data that moves or is shared instead of being copied: the `transfer` call
 * option, `call.transfer` in implementations, and `SharedArrayBuffer`s in calls and events.
 *
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#transfer
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#shared-buffers
 */
import { describe, expect, test } from "bun:test";
import { slot } from "racku";
import { codeOf, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const BYTES_RACK = {
  slots: { 1: slot("./devices/bytes.ts"), 3: slot("./devices/bytes-client.ts") },
};

const MB = 1 << 20;

// @doc docs/guides/data.md#moving-buffers
describe("transfer", () => {
  // README.md, "Binary data": a call moves the buffers listed in `transfer` and copies the rest.
  test("a call between devices moves the buffers listed in transfer, and copies by default", async () => {
    const { running } = await startRack(BYTES_RACK);
    const send = (size: number, move: boolean) =>
      running.call("bytes-client.client", "send", { size, move });
    expect(await send(MB, true)).toEqual({ length: MB, sum: MB, detachedAtOnce: true });
    expect(await send(1024, false)).toEqual({ length: 1024, sum: 1024, detachedAtOnce: false });
  });

  test("call.transfer moves a result to the caller, and results are copied by default", async () => {
    const { running } = await startRack(BYTES_RACK);
    const fetch = (size: number, move: boolean) =>
      running.call("bytes-client.client", "fetch", { size, move });
    expect(await fetch(MB, true)).toEqual({ length: MB, sum: 2 * MB });
    expect(await running.call("bytes.bytes", "kept", undefined)).toEqual({
      length: 0,
      detached: true,
    });
    expect(await fetch(1024, false)).toEqual({ length: 1024, sum: 2048 });
    expect(await running.call("bytes.bytes", "kept", undefined)).toEqual({
      length: 1024,
      detached: false,
    });
  });

  test("a call takes its buffers whatever its outcome, unless the transfer list is invalid", async () => {
    const { running } = await startRack(BYTES_RACK);
    const fail = (how: string) => running.call("bytes-client.client", "fail", how);
    expect(await fail("cancelled")).toEqual({ code: "RACK_CANCELLED", detached: true });
    expect(await fail("timeout")).toEqual({ code: "RACK_TIMEOUT", detached: true });
    expect(await fail("uncloneable")).toEqual({ code: "RACK_INVALID_INPUT", detached: true });
    expect(await fail("invalid")).toEqual({ code: "RACK_INVALID_INPUT", detached: false });
  });

  test("buffers an implementation lists with call.transfer are gone even when the call fails", async () => {
    const { running } = await startRack(BYTES_RACK);
    const make = running.call("bytes.bytes", "make", { size: 64, fill: 1, move: true, fail: true });
    expect(await codeOf(make)).toBe("BYTES_FAILED");
    expect(await running.call("bytes.bytes", "kept", undefined)).toEqual({
      length: 0,
      detached: true,
    });
  });

  test("call.transfer rejects a SharedArrayBuffer with RACK_INVALID_OUTPUT", async () => {
    const { running } = await startRack(BYTES_RACK);
    expect(await codeOf(running.call("bytes.bytes", "badTransfer", undefined))).toBe(
      "RACK_INVALID_OUTPUT",
    );
  });

  test("rack.call moves the buffers listed in transfer, and receives moved results", async () => {
    const { running } = await startRack(BYTES_RACK);
    const bytes = new Uint8Array(MB).fill(3);
    const pending = running.call("bytes.bytes", "inspect", { bytes }, { transfer: [bytes.buffer] });
    expect([bytes.buffer.detached, bytes.byteLength]).toEqual([true, 0]);
    expect(await pending).toEqual({ length: MB, sum: 3 * MB });
    const made = (await running.call("bytes.bytes", "make", {
      size: 64,
      fill: 5,
      move: true,
    })) as Uint8Array;
    expect([made.byteLength, made[63]]).toEqual([64, 5]);
    expect(await running.call("bytes.bytes", "kept", undefined)).toEqual({
      length: 0,
      detached: true,
    });
  });

  test("rack.call takes its buffers when it fails before it is sent, unless the list is invalid", async () => {
    const { running } = await startRack(BYTES_RACK);
    const attempt = async (
      address: string,
      input: (bytes: Uint8Array) => unknown,
      list: (buffer: ArrayBuffer) => ArrayBuffer[],
    ) => {
      const bytes = new Uint8Array(8);
      const code = await codeOf(
        running.call(address, "inspect", input(bytes), { transfer: list(bytes.buffer) }),
      );
      return { code, detached: bytes.buffer.detached };
    };
    const plain = (bytes: Uint8Array) => ({ bytes });
    const own = (buffer: ArrayBuffer) => [buffer];
    expect(await attempt("nowhere.bytes", plain, own)).toEqual({
      code: "RACK_NO_ROUTE",
      detached: true,
    });
    expect(await attempt("bytes.bytes", (bytes) => ({ bytes, callback: () => {} }), own)).toEqual({
      code: "RACK_INVALID_INPUT",
      detached: true,
    });
    for (const list of [
      (buffer: ArrayBuffer) => [buffer, buffer],
      (buffer: ArrayBuffer) => {
        const gone = new ArrayBuffer(8);
        gone.transfer();
        return [buffer, gone];
      },
      () => [new Uint8Array(8) as unknown as ArrayBuffer],
    ]) {
      expect(await attempt("bytes.bytes", plain, list)).toEqual({
        code: "RACK_INVALID_INPUT",
        detached: false,
      });
    }
    await running.stop();
    expect(await attempt("bytes.bytes", plain, own)).toEqual({
      code: "RACK_LINK_DOWN",
      detached: true,
    });
  });

  // README.md, "Binary data": calls held during a swap take their buffers at once.
  // @decision .agents/decisions/261116_024226-backplane-links.md#in-flight-calls-holding-and-draining
  test("calls that wait while their provider is swapped take their buffers at once and deliver them after the switch", async () => {
    const { running } = await startRack(BYTES_RACK);
    // A slow call keeps the old instance draining, so the hold lasts until it ends.
    const slow = running
      .call("bytes.bytes", "write", { bytes: new Uint8Array(1), value: 1, ms: 300 })
      .then(() => Date.now());
    await Bun.sleep(20);
    const sent = running.call("bytes-client.client", "sends", {
      n: 60,
      gapMs: 5,
      size: 1024,
    }) as Promise<{ detachedAtOnce: boolean; sums: number[] }>;
    await Bun.sleep(20);
    const swapped = running.swap("bytes");
    await waitFor(async () => {
      const client = (await running.metrics()).devices.find((d) => d.device === "bytes-client");
      const inspect = client?.needs.bytes?.inspect;
      return inspect?.kind === "rpc" && inspect.queued > 0;
    });
    // The slot is held, so a call from outside the rack waits at the backplane.
    const bytes = new Uint8Array(1024).fill(4);
    const outside = running
      .call("bytes.bytes", "inspect", { bytes }, { transfer: [bytes.buffer] })
      .then((result) => ({ result, at: Date.now() }));
    expect(bytes.buffer.detached).toBe(true);
    await swapped;
    const { detachedAtOnce, sums } = await sent;
    expect(detachedAtOnce).toBe(true);
    expect(sums).toEqual(Array.from({ length: 60 }, (_, i) => i * 1024));
    const { result, at } = await outside;
    expect(result).toEqual({ length: 1024, sum: 4096 });
    expect(at).toBeGreaterThanOrEqual(await slow);
  });
});

// @doc docs/guides/data.md#sharing-buffers
describe("shared buffers", () => {
  // README.md, "Binary data": a SharedArrayBuffer is shared, not copied.
  test("a SharedArrayBuffer in a call between devices is shared, not copied", async () => {
    const { running } = await startRack(BYTES_RACK);
    expect(await running.call("bytes-client.client", "share", undefined)).toBe(42);
  });

  test("rack.call shares a typed array on a SharedArrayBuffer with the provider", async () => {
    const { running } = await startRack(BYTES_RACK);
    const bytes = new Uint8Array(new SharedArrayBuffer(4));
    await running.call("bytes.bytes", "write", { bytes, value: 42, ms: 0 });
    expect(bytes[0]).toBe(42);
  });

  test("a SharedArrayBuffer in a result is shared with the caller", async () => {
    const { running } = await startRack(BYTES_RACK);
    const shared = (await running.call("bytes.bytes", "lend", undefined)) as SharedArrayBuffer;
    new Uint8Array(shared)[0] = 9;
    expect(await running.call("bytes.bytes", "peek", undefined)).toBe(9);
  });

  test("a SharedArrayBuffer in an event is shared with the subscribers", async () => {
    const { running } = await startRack(BYTES_RACK);
    await running.call("bytes.bytes", "publish", undefined);
    // The subscriber writes into the buffer it received, and the publisher sees the write.
    expect(
      await waitFor(async () => (await running.call("bytes.bytes", "peek", undefined)) === 7),
    ).toBe(true);
  });
});
