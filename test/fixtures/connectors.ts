/**
 * Connectors shared by the test devices and the tests.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#test-fixtures
 */
import { connector, event, rpc } from "rack42u";
import * as v from "valibot";

export const Hook = v.picklist([
  "powerOn",
  "selfTest",
  "activate",
  "deactivate",
  "snapshot",
  "restore",
  "powerOff",
]);

/** A device that exercises the backplane: echo, errors, waits, events, crashes. */
export const Probe = connector("test.probe/v1", {
  echo: rpc(v.unknown(), v.unknown()),
  fail: rpc(
    v.object({ code: v.optional(v.string()), message: v.string(), data: v.optional(v.unknown()) }),
    v.undefined(),
  ),
  wait: rpc(v.object({ ms: v.number() }), v.string()),
  aborts: rpc(v.undefined(), v.array(v.string())),
  info: rpc(
    v.undefined(),
    v.object({
      name: v.string(),
      u: v.number(),
      firmware: v.string(),
      baseDir: v.string(),
      env: v.nullable(v.string()),
      config: v.unknown(),
    }),
  ),
  bad: rpc(v.undefined(), v.string()),
  double: rpc(v.number(), v.number()),
  deadline: rpc(v.undefined(), v.number()),
  ping: rpc(v.object({ n: v.number() }), v.undefined()),
  emitBad: rpc(v.undefined(), v.string()),
  crash: rpc(v.picklist(["reject", "throw", "exit"]), v.undefined()),
  pinged: event(v.object({ n: v.number() })),
});

/** Forwards calls to a needed probe and records the events it receives. */
export const Relay = connector("test.relay/v1", {
  call: rpc(
    v.object({
      member: v.string(),
      input: v.unknown(),
      timeout: v.optional(v.number()),
      cancelAfter: v.optional(v.number()),
    }),
    v.object({
      ok: v.boolean(),
      value: v.unknown(),
      code: v.optional(v.string()),
      message: v.optional(v.string()),
      data: v.optional(v.unknown()),
    }),
  ),
  received: rpc(v.undefined(), v.array(v.number())),
});

/** A stateful counter whose count moves between instances through snapshot and restore. */
export const Counter = connector("test.counter/v1", {
  inc: rpc(v.undefined(), v.number()),
  /** Waits `ms`, then increments. */
  slowInc: rpc(v.number(), v.number()),
  get: rpc(v.undefined(), v.object({ n: v.number(), firmware: v.string(), version: v.string() })),
});

/** A device that records its lifecycle hooks and background ticks. */
export const Life = connector("test.life/v1", {
  ticks: rpc(v.undefined(), v.number()),
});

/** Records the `kv/v1` change events a device receives. */
export const Watcher = connector("test.watcher/v1", {
  changes: rpc(v.undefined(), v.array(v.string())),
});
