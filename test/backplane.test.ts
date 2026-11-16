/**
 * Tests for calls, errors, timeouts, cancellation, and events across the backplane.
 *
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#rpc
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#error-model
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#events
 */
import { describe, expect, test } from "bun:test";
import { slot } from "rack42u";
import { codeOf, errorOf, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

interface Relayed {
  ok: boolean;
  value: unknown;
  code?: string;
  message?: string;
  data?: unknown;
}

async function pair() {
  const { running } = await startRack({
    slots: { 1: slot("./devices/probe.ts"), 3: slot("./devices/relay.ts") },
  });
  const relay = (member: string, input: unknown, extra: object = {}) =>
    running.call("relay.relay", "call", { member, input, ...extra }) as Promise<Relayed>;
  return { running, relay };
}

describe("RPC", () => {
  test("rack.call reaches a port and returns its output", async () => {
    const { running } = await pair();
    expect(await running.call("probe.probe", "echo", { nested: [1, "two", null] })).toEqual({
      nested: [1, "two", null],
    });
  });

  test("devices call each other through the wiring", async () => {
    const { relay } = await pair();
    expect(await relay("double", 21)).toEqual({ ok: true, value: 42 });
  });

  test("a RackError thrown by a device reaches the caller with its code and data", async () => {
    const { running, relay } = await pair();
    const input = { code: "ORDER_NOT_FOUND", message: "no order 7", data: { id: 7 } };
    const error = await errorOf(running.call("probe.probe", "fail", input));
    expect([error.code, error.message, error.data]).toEqual([
      "ORDER_NOT_FOUND",
      "no order 7",
      { id: 7 },
    ]);
    expect(await relay("fail", input)).toMatchObject({
      ok: false,
      code: "ORDER_NOT_FOUND",
      message: "no order 7",
      data: { id: 7 },
    });
  });

  test("any other exception reaches the caller as RACK_DEVICE_FAULT with its message", async () => {
    const { running, relay } = await pair();
    const error = await errorOf(running.call("probe.probe", "fail", { message: "plain error" }));
    expect([error.code, error.message]).toEqual(["RACK_DEVICE_FAULT", "plain error"]);
    expect(await relay("fail", { message: "plain error" })).toMatchObject({
      code: "RACK_DEVICE_FAULT",
    });
  });

  // @decision .agents/decisions/261112_043035-backplane-protocol.md#where-validation-happens
  test("the provider validates input and output", async () => {
    const { running, relay } = await pair();
    expect(await codeOf(running.call("probe.probe", "double", "twenty"))).toBe(
      "RACK_INVALID_INPUT",
    );
    expect(await codeOf(running.call("probe.probe", "bad", undefined))).toBe("RACK_INVALID_OUTPUT");
    expect((await relay("double", "twenty")).code).toBe("RACK_INVALID_INPUT");
  });

  test("input that cannot be cloned fails with RACK_INVALID_INPUT", async () => {
    const { running } = await pair();
    expect(await codeOf(running.call("probe.probe", "echo", () => 1))).toBe("RACK_INVALID_INPUT");
  });

  test("unknown addresses and members fail with RACK_NO_ROUTE", async () => {
    const { running } = await pair();
    for (const [address, method] of [
      ["ghost.probe", "echo"],
      ["probe.ghost", "echo"],
      ["probe.probe", "ghost"],
      ["probe.probe", "pinged"],
      ["not an address", "echo"],
    ]) {
      expect(await codeOf(running.call(address as string, method as string, 1))).toBe(
        "RACK_NO_ROUTE",
      );
    }
  });

  test("the backplane times a call out and aborts the provider's call.signal", async () => {
    const { running, relay } = await pair();
    const result = await relay("wait", { ms: 5_000 }, { timeout: 50 });
    expect(result).toMatchObject({ ok: false, code: "RACK_TIMEOUT" });
    const aborts = await waitFor(async () => {
      const list = (await running.call("probe.probe", "aborts", undefined)) as string[];
      return list.length > 0 && list;
    });
    expect(["RACK_TIMEOUT", "RACK_CANCELLED"]).toContain(aborts[0] as string);
  });

  test("calls from outside the rack time out too", async () => {
    const { running } = await pair();
    const startedAt = Date.now();
    // The backplane's timer and the provider's deadline race; both report RACK_TIMEOUT.
    const error = await errorOf(
      running.call("probe.probe", "wait", { ms: 5_000 }, { timeout: 50 }),
    );
    expect(error.code).toBe("RACK_TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("the default timeout is the rack's callTimeout", async () => {
    const { running } = await startRack(
      { slots: { 1: slot("./devices/probe.ts") } },
      { callTimeout: 60 },
    );
    expect(await codeOf(running.call("probe.probe", "wait", { ms: 5_000 }))).toBe("RACK_TIMEOUT");
  });

  test("a cancelled call fails at once with RACK_CANCELLED and aborts the provider", async () => {
    const { running, relay } = await pair();
    const startedAt = Date.now();
    const result = await relay("wait", { ms: 5_000 }, { cancelAfter: 30 });
    expect(result).toMatchObject({ ok: false, code: "RACK_CANCELLED" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const aborts = await waitFor(async () => {
      const list = (await running.call("probe.probe", "aborts", undefined)) as string[];
      return list.length > 0 && list;
    });
    expect(aborts).toEqual(["RACK_CANCELLED"]);
  });

  test("callers outside the rack cancel with an AbortSignal", async () => {
    const { running } = await pair();
    const controller = new AbortController();
    const call = running.call("probe.probe", "wait", { ms: 5_000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await codeOf(call)).toBe("RACK_CANCELLED");
    const aborted = new AbortController();
    aborted.abort();
    expect(await codeOf(running.call("probe.probe", "echo", 1, { signal: aborted.signal }))).toBe(
      "RACK_CANCELLED",
    );
  });

  test("call.deadline is the moment the call times out", async () => {
    const { running } = await pair();
    const before = Date.now();
    const deadline = (await running.call("probe.probe", "deadline", undefined, {
      timeout: 5_000,
    })) as number;
    expect(deadline).toBeGreaterThanOrEqual(before + 5_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

describe("events", () => {
  test("subscribers receive events in emission order", async () => {
    const { running } = await pair();
    for (const n of [1, 2, 3, 4, 5]) await running.call("probe.probe", "ping", { n });
    const received = await waitFor(async () => {
      const list = (await running.call("relay.relay", "received", undefined)) as number[];
      return list.length === 5 && list;
    });
    expect(received).toEqual([1, 2, 3, 4, 5]);
  });

  test("an invalid payload rejects the emit with RACK_INVALID_OUTPUT", async () => {
    const { running } = await pair();
    expect(await running.call("probe.probe", "emitBad", undefined)).toBe("RACK_INVALID_OUTPUT");
  });
});
