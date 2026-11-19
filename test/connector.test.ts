/**
 * Tests for connector declarations.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#connectors
 */
import { describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";
import { z } from "zod";
import {
  connector,
  describeConnector,
  type EventInput,
  type EventNames,
  type EventPayload,
  event,
  type RpcInput,
  type RpcNames,
  type RpcOutput,
  type RpcParsedInput,
  type RpcReturn,
  rpc,
} from "../src/connector.ts";
import { RackError } from "../src/errors.ts";
import type { StandardSchemaV1 } from "../src/schema.ts";

/**
 * Runs `define` and returns the code of the `RackError` it throws, if any.
 *
 * The parameter is not named `declare`: Bun 1.3.13 drops any statement that begins with
 * `declare(`, as if it were a TypeScript `declare` declaration, so the call would never run.
 */
function rejectionCode(define: () => unknown): string | undefined {
  try {
    define();
  } catch (error) {
    if (error instanceof RackError) return error.code;
    throw error;
  }
  return undefined;
}

const Kv = connector("kv/v1", {
  get: rpc(v.string(), v.nullable(v.string())),
  set: rpc(v.object({ key: v.string(), value: v.string() }), v.undefined()),
  changed: event(v.object({ key: v.string() })),
});

describe("connector", () => {
  test("keeps the id and the member specs", () => {
    expect(Kv.id).toBe("kv/v1");
    expect(Kv.members.get.kind).toBe("rpc");
    expect(Kv.members.changed.kind).toBe("event");
  });

  // @doc docs/guides/connectors.md#ids-and-versions
  test.each(["kv/v1", "acme.orders/v2", "http/v1", "web-cache/v10"])("accepts the id %s", (id) => {
    expect(rejectionCode(() => connector(id, {}))).toBeUndefined();
  });

  // @doc docs/guides/connectors.md#ids-and-versions
  test.each(["kv", "KV/v1", "kv/1", "kv/v", "kv/v1.2", "kv_store/v1", "acme/orders/v1", ""])(
    "rejects the id '%s' with RACK_MANIFEST",
    (id) => {
      expect(rejectionCode(() => connector(id, {}))).toBe("RACK_MANIFEST");
    },
  );

  test.each(["get", "_internal", "$meta", "delete", "café", "名前"])(
    "accepts the member name %s",
    (name) => {
      const define = () => connector("x/v1", { [name]: rpc(v.string(), v.string()) });
      expect(rejectionCode(define)).toBeUndefined();
    },
  );

  test.each(["get-value", "1st", "has space", ""])(
    "rejects the member name '%s' with RACK_MANIFEST",
    (name) => {
      const define = () => connector("x/v1", { [name]: rpc(v.string(), v.string()) });
      expect(rejectionCode(define)).toBe("RACK_MANIFEST");
    },
  );
});

describe("rpc and event", () => {
  // @doc docs/guides/connectors.md#defining-a-connector
  test("accept zod schemas", () => {
    const Echo = connector("echo/v1", {
      echo: rpc(z.string(), z.string()),
      echoed: event(z.object({ at: z.number() })),
    });
    expect(describeConnector(Echo)).toEqual({
      id: "echo/v1",
      members: { echo: "rpc", echoed: "event" },
    });
  });

  test("reject schemas that do not implement Standard Schema", () => {
    const notASchema = {} as StandardSchemaV1;
    expect(rejectionCode(() => rpc(notASchema, v.string()))).toBe("RACK_MANIFEST");
    expect(rejectionCode(() => rpc(v.string(), notASchema))).toBe("RACK_MANIFEST");
    expect(rejectionCode(() => event(notASchema))).toBe("RACK_MANIFEST");
  });
});

// FRU data reports each port's connector id and member kinds, and it crosses threads.
// @decision .agents/decisions/261116_024226-backplane-links.md#boot-and-fru
describe("describeConnector", () => {
  test("lists member kinds as structured-cloneable data", () => {
    const info = describeConnector(Kv);
    expect(info).toEqual({ id: "kv/v1", members: { get: "rpc", set: "rpc", changed: "event" } });
    expect(structuredClone(info)).toEqual(info);
  });
});

describe("member types", () => {
  test("separate what callers send from what providers see", () => {
    const Units = connector("units/v1", {
      parse: rpc(
        v.pipe(v.string(), v.transform(Number)),
        v.pipe(
          v.number(),
          v.transform((n) => `${n}`),
        ),
      ),
      measured: event(
        v.pipe(
          v.string(),
          v.transform((text) => text.length),
        ),
      ),
    });
    type Parse = typeof Units.members.parse;
    type Measured = typeof Units.members.measured;

    expectTypeOf<RpcInput<Parse>>().toEqualTypeOf<string>();
    expectTypeOf<RpcParsedInput<Parse>>().toEqualTypeOf<number>();
    expectTypeOf<RpcReturn<Parse>>().toEqualTypeOf<number>();
    expectTypeOf<RpcOutput<Parse>>().toEqualTypeOf<string>();
    expectTypeOf<EventInput<Measured>>().toEqualTypeOf<string>();
    expectTypeOf<EventPayload<Measured>>().toEqualTypeOf<number>();
    expectTypeOf<RpcNames<typeof Units.members>>().toEqualTypeOf<"parse">();
    expectTypeOf<EventNames<typeof Units.members>>().toEqualTypeOf<"measured">();
  });
});
