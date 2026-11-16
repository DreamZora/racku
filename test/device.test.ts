/**
 * Tests for device definitions and their context types.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#devices
 * @decision .agents/decisions/261112_043034-device-api.md#device-context
 */
import { describe, expect, expectTypeOf, test } from "bun:test";
import { type CallContext, connector, device, event, RackError, rpc } from "rack42u";
import * as v from "valibot";
import { isDevice } from "../src/device.ts";

const Store = connector("test.store/v1", {
  get: rpc(v.string(), v.nullable(v.string())),
  set: rpc(v.object({ key: v.string(), value: v.string() }), v.undefined()),
  changed: event(v.object({ key: v.string() })),
});

function rejectionCode(define: () => unknown): string | undefined {
  try {
    define();
  } catch (error) {
    if (error instanceof RackError) return error.code;
    throw error;
  }
  return undefined;
}

describe("device", () => {
  test("fills in defaults and carries the device brand", () => {
    const def = device({ model: "plain" });
    expect(def.height).toBe(1);
    expect(def.needs).toEqual({});
    expect(def.provides).toEqual({});
    expect(isDevice(def)).toBe(true);
    expect(isDevice({ model: "plain" })).toBe(false);
    expect(Object.isFrozen(def)).toBe(true);
  });

  test.each([
    ["an empty model", { model: "" }],
    ["a zero height", { model: "x", height: 0 }],
    ["a fractional height", { model: "x", height: 1.5 }],
    ["a need that is not a connector", { model: "x", needs: { db: {} } }],
    ["a port name that is not an identifier", { model: "x", provides: { "my-port": Store } }],
    ["a config that is not a Standard Schema", { model: "x", config: {} }],
    ["a hook that is not a function", { model: "x", powerOn: "yes" }],
  ])("rejects %s with RACK_MANIFEST", (_label, spec) => {
    expect(rejectionCode(() => device(spec as never))).toBe("RACK_MANIFEST");
  });

  test("types the context from needs, provides, and config", () => {
    device({
      model: "typed",
      needs: { cache: Store },
      provides: { store: Store },
      config: v.object({ prefix: v.string() }),
      powerOn(ctx) {
        expectTypeOf(ctx.config).toEqualTypeOf<{ prefix: string }>();
        expectTypeOf(ctx.ports.cache.get).parameter(0).toEqualTypeOf<string>();
        expectTypeOf(ctx.ports.cache.get).returns.toEqualTypeOf<Promise<string | null>>();
        expectTypeOf(ctx.on.cache.changed)
          .parameter(0)
          .parameter(0)
          .toEqualTypeOf<{ key: string }>();
        expectTypeOf(ctx.emit.store.changed).parameter(0).toEqualTypeOf<{ key: string }>();
        return {
          store: {
            get: (key: string, call: CallContext) => {
              expectTypeOf(call.deadline).toEqualTypeOf<number>();
              return key;
            },
            set: async () => {},
          },
        };
      },
    });
  });
});
