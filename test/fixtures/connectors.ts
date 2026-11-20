/**
 * Connectors shared by the test devices and the tests.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#test-fixtures
 */
import { connector, event, rpc, stream } from "rack42u";
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
      /** Whether what the call rejected with is a RackError. */
      instance: v.optional(v.boolean()),
    }),
  ),
  received: rpc(v.undefined(), v.array(v.number())),
});

/** The port of a TCP echo server that a device opens itself, with `Bun.listen`. */
export const RawSocket = connector("test.raw-socket/v1", {
  port: rpc(v.undefined(), v.number()),
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

/** What a stream source or reader saw, as the stream tests report it. */
const Outcome = v.object({
  ok: v.boolean(),
  /** The error code of the call, or of the stream when the call succeeded and the stream failed. */
  code: v.nullable(v.string()),
  total: v.number(),
  chunks: v.number(),
  largest: v.number(),
});

/** Produces, consumes, and echoes byte streams, and reports what its sources saw. */
export const Streams = connector("test.streams/v1", {
  /**
   * Reads its input stream: all of it, or `take` chunks, waiting `delay` ms before each read,
   * then waits `after` ms before it returns. Reports what it read, the call's deadline, and the
   * code of an error the stream failed with.
   */
  consume: rpc(
    v.object({
      bytes: stream(),
      take: v.optional(v.number()),
      delay: v.optional(v.number()),
      after: v.optional(v.number()),
    }),
    v.object({
      total: v.number(),
      chunks: v.number(),
      largest: v.number(),
      sum: v.number(),
      deadline: v.number(),
      error: v.nullable(v.string()),
    }),
  ),
  /**
   * Returns a stream of `size` bytes set to `fill`, in chunks of `chunk` bytes, which its
   * source makes only when the stream reads it. The source waits `delay` ms before each chunk,
   * fails with `SOURCE_FAILED` at chunk `failAt`, makes a string at the first chunk with `junk`,
   * stops making anything after the first chunk with `stall`, and writes into the same buffer
   * again for each chunk with `reuse`.
   */
  produce: rpc(
    v.object({
      size: v.number(),
      chunk: v.number(),
      fill: v.optional(v.number()),
      delay: v.optional(v.number()),
      failAt: v.optional(v.number()),
      junk: v.optional(v.boolean()),
      stall: v.optional(v.boolean()),
      reuse: v.optional(v.boolean()),
    }),
    v.object({ size: v.number(), bytes: stream() }),
  ),
  /** Returns its input stream through a `TransformStream`. */
  echo: rpc(stream(), stream()),
  /**
   * What the instance saw: its firmware, the bytes its sources made, the codes they were
   * cancelled with, how many of their buffers were detached, and the codes of the input
   * streams that failed while `consume` read them.
   */
  report: rpc(
    v.undefined(),
    v.object({
      firmware: v.string(),
      produced: v.number(),
      cancelled: v.array(v.string()),
      detached: v.number(),
      consumeErrors: v.array(v.string()),
    }),
  ),
  /** Returns two streams at the top level, or one nested deeper. */
  bad: rpc(v.picklist(["two", "nested"]), v.unknown()),
  /** Emits a stream as the payload of `streamed`. */
  publish: rpc(v.undefined(), v.undefined()),
  /** Makes the next `snapshot` take `ms` ms. */
  slowSnapshot: rpc(v.number(), v.undefined()),
  /** Exits the Worker 10 ms after it answers. */
  crash: rpc(v.undefined(), v.undefined()),
  /** Keeps the event loop busy for `ms` ms. */
  block: rpc(v.number(), v.undefined()),
  streamed: event(v.unknown()),
});

/** Calls the streams device through a need, and reports what each side saw. */
export const StreamClient = connector("test.stream-client/v1", {
  /**
   * Starts a call to `consume` with a stream of `size` bytes in chunks of `chunk`, which its
   * source makes only when the stream reads it, `sourceDelay` ms apart, and stops making after
   * `stallAt` chunks. Returns an id for `finished` and `pulled`.
   */
  upload: rpc(
    v.object({
      size: v.number(),
      chunk: v.number(),
      sourceDelay: v.optional(v.number()),
      stallAt: v.optional(v.number()),
      take: v.optional(v.number()),
      delay: v.optional(v.number()),
      after: v.optional(v.number()),
      timeout: v.optional(v.number()),
      streamTimeout: v.optional(v.number()),
    }),
    v.number(),
  ),
  /** Bytes the source of an upload made so far. */
  pulled: rpc(v.number(), v.number()),
  /**
   * Waits for an upload: the call's outcome, what `consume` read, and the code its source was
   * cancelled with.
   */
  finished: rpc(
    v.number(),
    v.object({
      ok: v.boolean(),
      code: v.nullable(v.string()),
      total: v.number(),
      deadline: v.number(),
      cancelled: v.nullable(v.string()),
    }),
  ),
  /**
   * Calls `produce` with `args` and keeps the result's stream unread. Returns an id for `read`.
   */
  open: rpc(
    v.object({
      args: v.record(v.string(), v.unknown()),
      timeout: v.optional(v.number()),
      streamTimeout: v.optional(v.number()),
    }),
    v.number(),
  ),
  /**
   * Reads the stream that `open` kept: all of it, waiting `delay` ms before each read, or
   * `cancelAt` chunks and then cancels it.
   */
  read: rpc(
    v.object({ id: v.number(), delay: v.optional(v.number()), cancelAt: v.optional(v.number()) }),
    Outcome,
  ),
  /** Exits the Worker 10 ms after it answers. */
  crash: rpc(v.undefined(), v.undefined()),
});

/** A certificate and its key, as paths relative to the rack's base directory. */
export const PairPaths = v.object({
  cert: v.string(),
  key: v.string(),
  serverName: v.optional(v.string()),
});

/** Drives a device that serves HTTP and WebSocket on a listener of its own. */
export const ListenerControl = connector("test.listener/v1", {
  /** The URL of the device's first listener. */
  url: rpc(v.undefined(), v.string()),
  /** Replaces the certificates of the first listener. */
  setTls: rpc(v.union([PairPaths, v.array(PairPaths)]), v.undefined()),
  /** Publishes to a topic on the first listener. */
  publish: rpc(v.object({ topic: v.string(), data: v.string() }), v.number()),
  /** Replaces the handlers of the first listener with ones that answer with `label`. */
  reload: rpc(v.string(), v.undefined()),
  /** Sends `count` messages of `size` bytes to the WebSocket with `id`, as fast as it can. */
  flood: rpc(
    v.object({ id: v.number(), size: v.number(), count: v.number() }),
    v.object({ sent: v.number(), closed: v.boolean() }),
  ),
  /** What the instance saw: its label, the requests it served, and its WebSockets' close codes. */
  state: rpc(
    v.undefined(),
    v.object({ label: v.string(), served: v.number(), closes: v.array(v.number()) }),
  ),
});

/** Drives the test wrapper of the standard HTTP panel, which has no ports of its own. */
export const PanelControl = connector("test.panel/v1", {
  /** Exits the Worker 10 ms after it answers, as a crash of the panel. */
  crash: rpc(v.undefined(), v.undefined()),
});

/** Reports which device serves each need of a device whose needs come from its configuration. */
export const Picker = connector("test.picker/v1", {
  /** The name of the device behind each need, by need. */
  names: rpc(v.undefined(), v.record(v.string(), v.string())),
});

/**
 * The device that the bench's tests run: orders kept in a key-value store, and files in a blob
 * store, both of which the tests stub.
 *
 * @decision .agents/decisions/261118_173457-device-test-bench.md#tests
 */
export const Orders = connector("test.orders/v1", {
  /** Stores an order under `order:<id>` and emits `created`. */
  create: rpc(v.object({ item: v.string(), quantity: v.number() }), v.object({ id: v.string() })),
  /** The orders this instance and the ones it restored from created. */
  count: rpc(v.undefined(), v.number()),
  /** An order as the store has it, or `null`. */
  find: rpc(v.string(), v.nullable(v.string())),
  /** Passes any value to the store's `set`, so that a test can send it invalid input. */
  put: rpc(v.object({ key: v.string(), value: v.unknown() }), v.undefined()),
  /** The keys that the store's `changed` events named, oldest first. */
  seen: rpc(v.undefined(), v.array(v.string())),
  /** Stores a file in the blob store; resolves with its size. */
  upload: rpc(v.object({ name: v.string(), bytes: stream() }), v.number()),
  /** Reads a file from the blob store. */
  download: rpc(v.string(), v.object({ size: v.number(), bytes: stream() })),
  /** Throws from a timer, which crashes the device. */
  crash: rpc(v.undefined(), v.undefined()),
  created: event(v.object({ id: v.string() })),
});

/** A store of files, which the bench's tests stub. */
export const Blobs = connector("test.blobs/v1", {
  put: rpc(v.object({ name: v.string(), bytes: stream() }), v.number()),
  get: rpc(v.string(), v.object({ size: v.number(), bytes: stream() })),
});

const ImportMetaPaths = v.object({
  url: v.string(),
  dir: v.string(),
  dirname: v.string(),
  path: v.string(),
  filename: v.string(),
});

/**
 * The `import.meta` paths of a device file and of a helper in a subdirectory, which firmware
 * keeps, and a file that the device reads next to its source.
 */
export const Located = connector("test.located/v1", {
  where: rpc(
    v.undefined(),
    v.object({ device: ImportMetaPaths, helper: ImportMetaPaths, text: v.string() }),
  ),
});
