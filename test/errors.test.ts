/**
 * Tests for structured errors and their wire form.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#error-model
 */
import { describe, expect, test } from "bun:test";
import {
  fromWireError,
  isCloneable,
  isRackError,
  RackError,
  toWireError,
  type WireError,
} from "../src/errors.ts";

describe("RackError", () => {
  test("is an Error with a code and data", () => {
    const error = new RackError("RACK_TIMEOUT", "took too long", { ms: 30_000 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RackError");
    expect(error.code).toBe("RACK_TIMEOUT");
    expect(error.message).toBe("took too long");
    expect(error.data).toEqual({ ms: 30_000 });
  });
});

describe("toWireError", () => {
  test("keeps the code, message, and data of a RackError", () => {
    const wire = toWireError(new RackError("ORDER_NOT_FOUND", "no order 7", { id: 7 }));
    expect(wire).toEqual({ code: "ORDER_NOT_FOUND", message: "no order 7", data: { id: 7 } });
  });

  test("drops data that is not structured-cloneable", () => {
    const wire = toWireError(new RackError("ORDER_NOT_FOUND", "no order 7", { retry() {} }));
    expect(wire).toEqual({ code: "ORDER_NOT_FOUND", message: "no order 7" });
    expect(Object.hasOwn(wire, "data")).toBe(false);
  });

  test("turns other errors into RACK_DEVICE_FAULT and keeps the message", () => {
    expect(toWireError(new TypeError("x is undefined"))).toEqual({
      code: "RACK_DEVICE_FAULT",
      message: "x is undefined",
    });
  });

  const thrownValues: Array<[string, unknown, string]> = [
    ["a string", "boom", "boom"],
    ["undefined", undefined, "undefined"],
    ["a number", 42, "42"],
    ["a plain object", { reason: "boom" }, "[object Object]"],
    ["an object without a prototype", Object.create(null), "[object Object]"],
  ];
  test.each(thrownValues)("converts %s without throwing", (_label, thrown, message) => {
    expect(toWireError(thrown)).toEqual({ code: "RACK_DEVICE_FAULT", message });
  });
});

describe("fromWireError", () => {
  test("revives a RackError after the wire form crosses a message port", async () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const received = new Promise<WireError>((resolve) => {
        port2.onmessage = (message) => resolve(message.data);
      });
      port1.postMessage(toWireError(new RackError("ORDER_NOT_FOUND", "no order 7", { id: 7 })));
      const revived = fromWireError(await received);

      expect(revived).toBeInstanceOf(RackError);
      expect(revived.code).toBe("ORDER_NOT_FOUND");
      expect(revived.message).toBe("no order 7");
      expect(revived.data).toEqual({ id: 7 });
    } finally {
      port1.close();
      port2.close();
    }
  });
});

describe("isRackError", () => {
  test("accepts only RackError instances", () => {
    expect(isRackError(new RackError("RACK_TIMEOUT", "late"))).toBe(true);
    expect(isRackError(fromWireError({ code: "RACK_TIMEOUT", message: "late" }))).toBe(true);
    expect(isRackError(new Error("late"))).toBe(false);
    expect(isRackError({ code: "RACK_TIMEOUT", message: "late" })).toBe(false);
  });
});

describe("isCloneable", () => {
  test("accepts structured-cloneable values", () => {
    const values = [null, "text", 1, { list: [1, 2] }, new Uint8Array([1]), new Map([[1, 2]])];
    for (const value of values) expect(isCloneable(value)).toBe(true);
  });

  test("rejects functions, symbols, and objects that hold them", () => {
    for (const value of [() => 1, Symbol("s"), { run: () => 1 }]) {
      expect(isCloneable(value)).toBe(false);
    }
  });
});
