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

/** Makes calls between devices on demand, to observe links without the rack in the middle. */
export const Pump = connector("test.pump/v1", {
  /** Makes `n` echo calls one after another; reports when the first started and the last ended. */
  burst: rpc(
    v.object({ n: v.number() }),
    v.object({ startedAt: v.number(), finishedAt: v.number() }),
  ),
  /**
   * Starts `n` counter increments `gapMs` apart without waiting for them; returns their results
   * in call order and the longest time one of them took.
   */
  incs: rpc(
    v.object({ n: v.number(), gapMs: v.number() }),
    v.object({ values: v.array(v.number()), maxMs: v.number() }),
  ),
  /** When each `pinged` event from the probe arrived, as millisecond timestamps. */
  pings: rpc(v.undefined(), v.array(v.number())),
  /** Blocks the device's Worker for `ms` milliseconds. */
  spin: rpc(v.object({ ms: v.number() }), v.undefined()),
});

/** A provider that can be kept busy or crashed, to exercise races around swaps and resets. */
export const Busy = connector("test.busy/v1", {
  /** Returns the id of the instance that answers. */
  whoami: rpc(v.undefined(), v.string()),
  /** Blocks the device's Worker for `ms` milliseconds. */
  spin: rpc(v.object({ ms: v.number() }), v.undefined()),
  /** Exits the device's Worker right after answering. */
  crash: rpc(v.undefined(), v.undefined()),
});

/** Calls a busy provider on demand, and can be kept busy or crashed itself. */
export const Client = connector("test.client/v1", {
  /** Calls `whoami` and reports the outcome instead of throwing. */
  call: rpc(
    v.object({ timeout: v.optional(v.number()) }),
    v.object({ ok: v.boolean(), by: v.optional(v.string()), code: v.optional(v.string()) }),
  ),
  /** Blocks the device's Worker for `ms` milliseconds. */
  spin: rpc(v.object({ ms: v.number() }), v.undefined()),
  /** Exits the device's Worker right after answering. */
  crash: rpc(v.undefined(), v.undefined()),
});

/** A provider of binary data, to observe what calls and events copy, move, or share. */
export const Bytes = connector("test.bytes/v1", {
  /** Reports the length and the sum of the bytes that arrived. */
  inspect: rpc(
    v.object({ bytes: v.instance(Uint8Array) }),
    v.object({ length: v.number(), sum: v.number() }),
  ),
  /**
   * Returns `size` bytes set to `fill`, moved with the result when `move` is set, and keeps them
   * so `kept` can report on them. With `fail` set, it lists the bytes for transfer and then
   * throws `BYTES_FAILED`.
   */
  make: rpc(
    v.object({
      size: v.number(),
      fill: v.number(),
      move: v.boolean(),
      fail: v.optional(v.boolean()),
    }),
    v.instance(Uint8Array),
  ),
  /** How the provider now sees the bytes `make` returned last. */
  kept: rpc(v.undefined(), v.object({ length: v.number(), detached: v.boolean() })),
  /** Lists a shared buffer for transfer, which fails. */
  badTransfer: rpc(v.undefined(), v.undefined()),
  /** Waits `ms` milliseconds, then writes `value` into the first byte. */
  write: rpc(
    v.object({ bytes: v.instance(Uint8Array), value: v.number(), ms: v.number() }),
    v.undefined(),
  ),
  /** Writes `value` into the first byte of a shared buffer. */
  mark: rpc(v.object({ shared: v.instance(SharedArrayBuffer), value: v.number() }), v.undefined()),
  /** Emits `shared` with a new shared buffer of 4 bytes, and keeps it so `peek` can read it. */
  publish: rpc(v.undefined(), v.undefined()),
  /** Returns a new shared buffer of 4 bytes, and keeps it so `peek` can read it. */
  lend: rpc(v.undefined(), v.instance(SharedArrayBuffer)),
  /** The first byte of the buffer `publish` emitted or `lend` returned last. */
  peek: rpc(v.undefined(), v.number()),
  shared: event(v.object({ shared: v.instance(SharedArrayBuffer) })),
});

/** Calls the bytes provider on demand and reports what each side saw. */
export const BytesClient = connector("test.bytes-client/v1", {
  /**
   * Sends `size` bytes set to 1, moved when `move` is set. Reports what the provider received,
   * and whether the caller's buffer was detached right after the call was made.
   */
  send: rpc(
    v.object({ size: v.number(), move: v.boolean() }),
    v.object({ length: v.number(), sum: v.number(), detachedAtOnce: v.boolean() }),
  ),
  /** Calls `make` and reports the length and the sum of the bytes that came back. */
  fetch: rpc(
    v.object({ size: v.number(), move: v.boolean() }),
    v.object({ length: v.number(), sum: v.number() }),
  ),
  /**
   * Makes a call that moves a buffer and fails: `cancelled` before it is sent, `timeout` while
   * the provider works, `uncloneable` input, or an `invalid` transfer list. Reports the error
   * code and whether the buffer was detached.
   */
  fail: rpc(
    v.picklist(["cancelled", "timeout", "uncloneable", "invalid"]),
    v.object({ code: v.string(), detached: v.boolean() }),
  ),
  /**
   * Starts `n` calls `gapMs` apart that each move `size` bytes set to their index, without
   * waiting for them. Reports whether every buffer was detached right after its call was made,
   * and the sums the provider received, in call order.
   */
  sends: rpc(
    v.object({ n: v.number(), gapMs: v.number(), size: v.number() }),
    v.object({ detachedAtOnce: v.boolean(), sums: v.array(v.number()) }),
  ),
  /** Passes a shared buffer to `mark` and returns its first byte after the call. */
  share: rpc(v.undefined(), v.number()),
});
