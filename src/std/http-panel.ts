/**
 * The `http-panel` standard device: it listens for HTTP and WebSocket with `ctx.serve`, and
 * passes each request and each WebSocket message through `http/v2` to the port its route names.
 *
 * This file is device code and runs only in its Worker. It imports the framework through the
 * package name, so the firmware keeps the framework external instead of bundling a copy.
 *
 * @decision .agents/decisions/261118_071513-http-panel-device.md#the-device
 * @decision .agents/decisions/261118_071513-http-panel-device.md#configuration
 * @decision .agents/decisions/261118_071513-http-panel-device.md#requests
 * @decision .agents/decisions/261118_071513-http-panel-device.md#websocket
 * @decision .agents/decisions/261118_071513-http-panel-device.md#certificates-that-change
 * @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
 * @decision .agents/decisions/261118_165318-stream-threshold.md#the-threshold
 * @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#wholeresponse
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type CallOptions,
  type DeviceContext,
  device,
  type Listener,
  type ListenerTls,
  patched,
  RackError,
  wholeResponse,
} from "racku";
import { Http } from "racku/std";
import * as v from "valibot";

const MiB = 1024 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;
/**
 * The default largest request body, of a declared length, that goes to the device as bytes: a
 * stream's window, which a stream of a body that size would fill at once anyway.
 */
const STREAM_THRESHOLD = 256 * 1024;
/**
 * The smallest request body that the call moves instead of copying; below it, the copy costs the
 * receiving thread less, as `httpHandler` notes for response bodies.
 */
const MOVE_FROM = 1024;
/** The message of the 408 for a body sent whole that didn't arrive within `idleTimeout`. */
const LATE_BODY = "the client didn't send its body within idleTimeout";
/** The message of the 408 for a streamed body that stopped for `idleTimeout`. */
const STOPPED_BODY = "the client stopped sending its body";
/** The message of the 408 for a streamed body below {@link MIN_RATE}. */
const SLOW_BODY = "the client sent its body too slowly";
/**
 * The lowest average rate of a body that streams, in bytes per second, once its first
 * `idleTimeout` has passed: 1 KiB/s. It lets a body of 1 MiB take about 17 minutes, and makes
 * holding a device's `queueLimit` calls with slow bodies cost a client about 10 MiB/s.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
 */
const MIN_RATE = 1024;
/**
 * How often a kind of warning goes to the log at most: once a minute, with a count of the rest.
 * Tests shorten it through the environment, as {@link SYNC_MS}. Exported for the tests of its
 * default.
 */
export const WARN_EVERY_MS = Number(process.env.RACKU_TEST_PANEL_WARN_MS) || 60_000;
/** The most message calls a socket has unfinished. */
const MESSAGES_IN_FLIGHT = 16;
/**
 * How often the panel checks its WebSockets with the devices behind it: every 30 s. Tests
 * shorten it through the environment, which a Worker copies as it starts, so as not to wait.
 * Exported for the tests of its default.
 */
export const SYNC_MS = Number(process.env.RACKU_TEST_PANEL_SYNC_MS) || 30_000;

const whole = (low: number, high: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(low), v.maxValue(high));
const Pair = v.object({ cert: v.string(), key: v.string(), serverName: v.optional(v.string()) });

/**
 * The configuration of the panel, with its defaults; `HttpPanelConfig` in `racku/std`
 * describes the fields. Exported for the tests of its defaults.
 */
export const PanelConfig = v.object({
  hostname: v.optional(v.pipe(v.string(), v.minLength(1)), "127.0.0.1"),
  port: whole(0, 65_535),
  routes: v.record(
    v.string(),
    v.pipe(v.string(), v.regex(/^[^.]+\.[^.]+$/, "must be a <device>.<port> address")),
  ),
  maxBodySize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), MiB),
  streamThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), STREAM_THRESHOLD),
  idleTimeout: v.optional(whole(1, 255), 10),
  tls: v.optional(v.union([Pair, v.pipe(v.array(Pair), v.minLength(1))])),
  certificateCheck: v.optional(whole(1, 3_600), 60),
  allowedHosts: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  webSocket: v.optional(
    v.object({
      maxMessageSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), MiB),
      maxConnections: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10_000),
    }),
    {},
  ),
});

type Config = v.InferOutput<typeof PanelConfig>;
type HttpInput = v.InferInput<(typeof Http.members.handle)["input"]>;
type PanelNeeds = Record<string, ReturnType<typeof patched<typeof Http>>>;
type Ctx = DeviceContext<PanelNeeds, Record<never, never>, Config>;

/**
 * The name of the need for a route target: the address with `.` and `-` as `_`, and a `_` in
 * front when it starts with a digit, since need names are identifiers.
 */
function needName(address: string): string {
  const name = address.replace(/[.-]/g, "_");
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** One shared `http/v2` need per distinct route target, wired to its address. */
function routeNeeds(config: Config): PanelNeeds {
  const needs: PanelNeeds = {};
  const by = new Map<string, string>();
  for (const address of new Set(Object.values(config.routes))) {
    const name = needName(address);
    const other = by.get(name);
    if (other !== undefined && other !== address) {
      throw new RackError(
        "RACK_INVALID_CONFIG",
        `the routes to ${other} and ${address} give one need name, ${name}`,
      );
    }
    by.set(name, address);
    needs[name] = patched(Http, address);
  }
  return needs;
}

/** What the panel keeps of each WebSocket. */
interface Socket {
  ws: Bun.ServerWebSocket<SocketData>;
  need: string;
  /** Its `opened` call returned. */
  opened: boolean;
  inFlight: number;
  /** Messages Bun delivered after the pause, in order, which wait for a call. */
  held: (string | Bytes)[];
  paused: boolean;
  /** `sockets` calls in a row whose device didn't know the socket. */
  unknown: number;
}

interface SocketData {
  socket: string;
  need: string;
}

/** A certificate pair as the panel loaded it from its files. */
interface Loaded {
  certPath: string;
  keyPath: string;
  serverName: string | undefined;
  cert: string;
  key: string;
  /** Contents that didn't load, and how many checks in a row found them. */
  bad: { cert: string; key: string; seen: number } | undefined;
}

/** Which instance of the panel this is, for the ids of its sockets. */
const instance = Math.random().toString(36).slice(2, 10);
const sockets = new Map<string, Socket>();
/**
 * Upgrades in flight, which count among `maxConnections`: from before the panel calls the device
 * until the socket opens, with a timer once Bun has the upgrade, for a socket that never opens.
 */
const upgrades = new Map<string, ReturnType<typeof setTimeout> | undefined>();
let socketCount = 0;
let refusing = false;
let listener: Listener<SocketData> | undefined;
let loaded: Loaded[] = [];

/**
 * How long a call waits for its response head before the panel reads its client's signal: one
 * to two ticks of 100 ms.
 */
const SIGNAL_TICK_MS = 100;

/**
 * A request in the panel: its call's controller, and who stalled its body, all in one object, so
 * that a request allocates as little as it can.
 */
interface Waiting {
  request: Request;
  aborter: AbortController;
  /** The client's signal can abort `aborter`: the controller can't serve another call. */
  attached: boolean;
  /** Why the client's body stalled, as the 408's message says it; `undefined` while it didn't. */
  client: string | undefined;
  /** The device stopped taking the body. */
  device: boolean;
}

/**
 * The calls that wait for a response head, in two generations: a tick attaches the client's
 * signal to the calls that were already waiting at the tick before.
 *
 * Reading `request.signal` makes Bun build a signal for the request, which cost about a tenth of
 * a small request's time in the panel, and most calls answer before a tick. A signal that the
 * panel reads after its client went away comes back aborted, as measured on Linux, so a call
 * whose client went away is still cancelled, at most two ticks after it started.
 *
 * @decision .agents/decisions/261118_165318-stream-threshold.md#cancellation
 */
let fresh = new Set<Waiting>();
let aged = new Set<Waiting>();
let signalTicker: ReturnType<typeof setInterval> | undefined;

function watchClient(waiting: Waiting): void {
  fresh.add(waiting);
  signalTicker ??= setInterval(attachSignals, SIGNAL_TICK_MS);
}

function unwatchClient(waiting: Waiting): void {
  if (!fresh.delete(waiting)) aged.delete(waiting);
}

function attachSignals(): void {
  const due = aged;
  aged = fresh;
  fresh = due;
  for (const waiting of due) {
    const { request, aborter } = waiting;
    waiting.attached = true;
    const signal = request.signal;
    if (signal.aborted) aborter.abort(signal.reason);
    else signal.addEventListener("abort", () => aborter.abort(signal.reason), { once: true });
  }
  due.clear();
  if (aged.size === 0) {
    clearInterval(signalTicker);
    signalTicker = undefined;
  }
}

/**
 * Controllers of calls that ended without being aborted, while nothing but the ended call
 * listened to them, kept for later calls: creating one cost about 3% of a small request's time
 * in the panel's Worker. At most 1 024 are kept.
 */
const spareAborters: AbortController[] = [];
const SPARE_ABORTERS = 1024;

function json(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

function codeOf(error: unknown): string {
  return error instanceof RackError ? error.code : "RACK_DEVICE_FAULT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a certificate and a key belong together and load. */
function pairLoads(cert: string, key: string): boolean {
  try {
    return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key));
  } catch {
    // A file written halfway, or not PEM at all: the pair doesn't load.
    return false;
  }
}

function tlsOf(pairs: readonly Loaded[]): ListenerTls | ListenerTls[] {
  const list = pairs.map((p) => ({
    cert: p.cert,
    key: p.key,
    ...(p.serverName === undefined ? {} : { serverName: p.serverName }),
  }));
  return list.length === 1 && list[0]?.serverName === undefined ? (list[0] as ListenerTls) : list;
}

/**
 * What the body of a failed request says for the codes that the rack makes, in general terms:
 * the log keeps the details, such as an exception's message, paths, device names, and limits.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
 */
const GENERAL: Record<string, string> = {
  RACK_DEVICE_FAULT: "the device failed",
  RACK_LINK_DOWN: "the device is unavailable",
  RACK_OVERLOADED: "the device is overloaded",
  RACK_TIMEOUT: "the device didn't answer in time",
  RACK_CANCELLED: "the request was cancelled",
  RACK_INVALID_INPUT: "the device refused the request",
  RACK_INVALID_OUTPUT: "the device's answer isn't valid",
};

/** When each kind of sampled warning last went to the log, and how many came since. */
const warned = new Map<string, { at: number; since: number }>();

/**
 * Logs a warning at most once a minute for each `key`, with `since`, how many came after the last
 * one that the log got. The keys are few: kinds of warning, and the rack's codes per route target.
 */
function warnSampled(ctx: Ctx, key: string, message: string, data: Record<string, unknown>): void {
  const now = Date.now();
  const last = warned.get(key);
  if (last !== undefined && now - last.at < WARN_EVERY_MS) {
    last.since++;
    return;
  }
  warned.set(key, { at: now, since: 0 });
  ctx.log.warn(
    message,
    last === undefined || last.since === 0 ? data : { ...data, since: last.since },
  );
}

/** A route's target: the need that the panel calls, and the address that it names. */
interface Target {
  need: string;
  address: string;
}

/** Why a request failed, as a status: what the decision's table of statuses says. */
function statusFor(
  ctx: Ctx,
  target: Target,
  error: unknown,
  stalled: { client: string | undefined; device: boolean },
): Response {
  if (stalled.client !== undefined) {
    warnSampled(ctx, "slow body", "a client's body stalled or came too slowly", {
      route: target.address,
      reason: stalled.client,
    });
    return json(408, "RACK_TIMEOUT", stalled.client);
  }
  if (stalled.device) return json(504, "RACK_TIMEOUT", "the device stopped reading the body");
  const code = codeOf(error);
  const general = GENERAL[code] ?? (code.startsWith("RACK_") ? "the request failed" : undefined);
  if (general === undefined) {
    // A code that the device defines keeps the message that the device chose to send.
    return json(502, code, messageOf(error));
  }
  warnSampled(ctx, `call ${code} ${target.address}`, "a request failed", {
    route: target.address,
    code,
    error: messageOf(error),
  });
  if (code === "RACK_LINK_DOWN" || code === "RACK_OVERLOADED") return json(503, code, general);
  if (code === "RACK_TIMEOUT") return json(504, code, general);
  return json(502, code, general);
}

/** Why reading a client's body failed, as Bun reports it. */
function bodyError(error: unknown): RackError {
  // Bun fails the body of a chunked request that crosses maxRequestBodySize, and answers the
  // client with 413 itself.
  return messageOf(error).includes("maxRequestBodySize")
    ? new RackError("RACK_INVALID_INPUT", "the body is larger than maxBodySize")
    : new RackError("RACK_CANCELLED", `the client went away: ${messageOf(error)}`);
}

/**
 * Reads a body of a declared length up to `streamThreshold`, which goes to the device as bytes,
 * in a buffer of its own that the call moves. It fails with `RACK_TIMEOUT` when the body hasn't
 * arrived in full within `idle` s.
 *
 * Bun reads it natively, as `request.bytes()`, which in a probe on Linux served more than twice
 * the small requests that a reader in JavaScript did; but it shows no progress, so the bound is
 * on the whole body instead of on its idle time.
 *
 * @decision .agents/decisions/261118_165318-stream-threshold.md#bodies-sent-whole
 */
function readWhole(
  request: Request,
  idle: number,
  stalled: { client: string | undefined },
): Promise<Bytes> {
  const reading = request.bytes() as Promise<Bytes>;
  return new Promise<Bytes>((resolve, reject) => {
    const deadline: Deadline = {
      expires: performance.now() + idle * 1000,
      queued: false,
      older: undefined,
      newer: undefined,
      expire() {
        stalled.client = LATE_BODY;
        // Bun fails the read once the panel answers; nothing waits for it any more.
        reading.catch(() => undefined);
        reject(new RackError("RACK_TIMEOUT", LATE_BODY));
      },
    };
    bodyDeadlines.add(deadline);
    reading.then(
      (bytes) => {
        if (bodyDeadlines.remove(deadline)) resolve(bytes);
      },
      (error: unknown) => {
        if (bodyDeadlines.remove(deadline)) {
          reject(error instanceof RackError ? error : bodyError(error));
        }
      },
    );
  });
}

/** A body read's deadline in {@link bodyDeadlines}. */
interface Deadline {
  /** On `performance.now()`'s clock. */
  readonly expires: number;
  /** It is in the queue: added, and neither removed nor expired. */
  queued: boolean;
  older: Deadline | undefined;
  newer: Deadline | undefined;
  expire(): void;
}

/**
 * The deadlines of the bodies being read whole, oldest first. Every body of an instance has the
 * same `idleTimeout`, so they expire in the order they started, and one timer, for the oldest,
 * serves them all, where each body would otherwise arm, race, and clear one of its own.
 */
const bodyDeadlines = new (class {
  #oldest: Deadline | undefined;
  #newest: Deadline | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  add(deadline: Deadline): void {
    deadline.queued = true;
    deadline.older = this.#newest;
    if (this.#newest === undefined) this.#oldest = deadline;
    else this.#newest.newer = deadline;
    this.#newest = deadline;
    if (this.#timer === undefined) this.#arm();
  }

  /** Takes a deadline out; `false` when it had expired already. */
  remove(deadline: Deadline): boolean {
    if (!deadline.queued) return false;
    deadline.queued = false;
    if (deadline.older === undefined) this.#oldest = deadline.newer;
    else deadline.older.newer = deadline.newer;
    if (deadline.newer === undefined) this.#newest = deadline.older;
    else deadline.newer.older = deadline.older;
    deadline.older = undefined;
    deadline.newer = undefined;
    if (this.#oldest === undefined && this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    return true;
  }

  #arm(): void {
    const oldest = this.#oldest;
    if (oldest === undefined) return;
    this.#timer = setTimeout(() => this.#expire(), Math.max(0, oldest.expires - performance.now()));
  }

  #expire(): void {
    this.#timer = undefined;
    // A timer can fire a little early on its clock; a millisecond is within its precision.
    const now = performance.now() + 1;
    for (let oldest = this.#oldest; oldest !== undefined && oldest.expires <= now; ) {
      this.remove(oldest);
      oldest.expire();
      oldest = this.#oldest;
    }
    if (this.#timer === undefined) this.#arm();
  }
})();

/** A reader of a request body; the stream types of Bun and of `node:stream/web` both fit it. */
interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

/** How much of a streamed body arrived, and how long the panel waited for it, in ms. */
interface Meter {
  bytes: number;
  waited: number;
}

/**
 * The request body as the panel streams it on, after the chunks that it read already: a stream
 * that fails with `RACK_TIMEOUT` when the client sends nothing for `idle` s, or when its body
 * arrives slower than {@link MIN_RATE} on average once `idle` s have passed, and with
 * `RACK_INVALID_INPUT` when it crosses the limit.
 *
 * The rate counts the time that the panel waits for the client's bytes, from the start of the
 * request, and not the time that it waits for the device to take them, so that a device that
 * reads slowly doesn't count against its client.
 *
 * The stream to the device times out after the same time at both of its ends, whichever party
 * stalled. So when it is cancelled with `RACK_TIMEOUT`, the stall is the client's if the panel
 * was waiting for the client's bytes, and the device's if it was waiting for the device to take
 * them; only then does the panel give up the call.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
 */
function guard(
  reader: Reader,
  taken: Uint8Array[],
  meter: Meter,
  idle: number,
  stalled: { client: string | undefined; device: boolean },
  abort: () => void,
): ReadableStream<Uint8Array> {
  let waiting = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const first = taken.shift();
        if (first !== undefined) {
          controller.enqueue(first);
          return;
        }
        // This read may last until the client has been idle for idleTimeout, or until the
        // average rate would fall below the minimum, whichever comes first.
        const idleMs = idle * 1000;
        const left = Math.max(idleMs, (meter.bytes / MIN_RATE) * 1000) - meter.waited;
        const why = left < idleMs ? SLOW_BODY : STOPPED_BODY;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const quiet = new Promise<"quiet">((resolve) => {
          timer = setTimeout(() => resolve("quiet"), Math.max(0, Math.min(idleMs, left)));
        });
        waiting = true;
        const begun = performance.now();
        try {
          const next = await Promise.race([reader.read(), quiet]);
          meter.waited += performance.now() - begun;
          if (next === "quiet") {
            stalled.client = why;
            void reader.cancel().catch(() => undefined);
            controller.error(new RackError("RACK_TIMEOUT", why));
            return;
          }
          if (next.done || next.value === undefined) controller.close();
          else {
            meter.bytes += next.value.byteLength;
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(bodyError(error));
        } finally {
          waiting = false;
          clearTimeout(timer);
        }
      },
      cancel(reason) {
        if (
          reason instanceof RackError &&
          reason.code === "RACK_TIMEOUT" &&
          stalled.client === undefined
        ) {
          if (waiting) stalled.client = STOPPED_BODY;
          else {
            stalled.device = true;
            abort();
          }
        }
        // The client's body is no longer needed; a failure to cancel it changes nothing.
        return reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Reads a body without a declared length, such as a chunked one: whole when it ends within
 * `threshold` bytes, under the deadline of a body sent whole, `idle` s for all of it; or, once it
 * passes `threshold` within that time, as a stream of what it read and of the rest, which
 * {@link guard} watches.
 *
 * @throws RackError `RACK_TIMEOUT` when it neither ends nor passes `threshold` within `idle` s.
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
 */
function readUnknown(
  source: ReadableStream<Uint8Array>,
  threshold: number,
  idle: number,
  stalled: { client: string | undefined; device: boolean },
  abort: () => void,
): Promise<Bytes | ReadableStream<Uint8Array>> {
  const reader: Reader = source.getReader();
  const begun = performance.now();
  const chunks: Uint8Array[] = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    const deadline: Deadline = {
      expires: begun + idle * 1000,
      queued: false,
      older: undefined,
      newer: undefined,
      expire() {
        stalled.client = LATE_BODY;
        void reader.cancel().catch(() => undefined);
        reject(new RackError("RACK_TIMEOUT", LATE_BODY));
      },
    };
    bodyDeadlines.add(deadline);
    const next = (): void => {
      reader.read().then(
        (read) => {
          if (!deadline.queued) return;
          if (read.done || read.value === undefined) {
            bodyDeadlines.remove(deadline);
            resolve(joined(chunks, size));
            return;
          }
          chunks.push(read.value);
          size += read.value.byteLength;
          if (size <= threshold) {
            next();
            return;
          }
          bodyDeadlines.remove(deadline);
          const meter = { bytes: size, waited: performance.now() - begun };
          resolve(guard(reader, chunks, meter, idle, stalled, abort));
        },
        (error: unknown) => {
          if (bodyDeadlines.remove(deadline)) reject(bodyError(error));
        },
      );
    };
    next();
  });
}

/** The chunks of a body in one buffer of its own, which the call can move. */
function joined(chunks: readonly Uint8Array[], size: number): Bytes {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A response body stream that runs `done` once it ends, fails, or is cancelled. It runs `done`
 * when the device's stream fails even while Bun isn't reading, as for a client that stopped
 * reading, so that Bun's timer, set back by `done`, closes the connection.
 */
function watched(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    done();
  };
  reader.closed.catch(end);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            end();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          end();
          // The body failed after its head: the client sees the response end abruptly.
          controller.error(error);
        }
      },
      cancel(reason) {
        end();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Tells the device that an upgrade it accepted didn't complete, with a `closed` call of 1006, so
 * that it forgets the socket.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
 */
function unopened(ctx: Ctx, need: string, socket: string): void {
  const port = ctx.ports[need] as Ctx["ports"][string];
  // A failed closed call is only counted, by the need's counters.
  void port
    .closed({ socket, code: 1006, reason: "the upgrade didn't complete" })
    .catch(() => undefined);
}

/** Gives back an upgrade's place among `maxConnections`. */
function release(socket: string): void {
  clearTimeout(upgrades.get(socket));
  upgrades.delete(socket);
}

/** Reads a request's body as the device gets it: none, bytes, or a stream. */
async function bodyOf(
  request: Bun.BunRequest<string>,
  config: Config,
  stalled: Waiting,
  options: CallOptions,
): Promise<Bytes | ReadableStream<Uint8Array> | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const idle = config.idleTimeout;
  const abort = () => stalled.aborter.abort();
  // A body sent whole is told by its declared length, without `request.body`, for which Bun
  // would build a stream that `bytes()` doesn't use; a declared length of 0 has no body.
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) <= config.streamThreshold) {
    if (Number(length) === 0) return null;
    const body = await readWhole(request, idle, stalled);
    // Bun's bytes() gives a buffer of its own, as measured on Linux; the call moves it.
    if (
      body.byteLength >= MOVE_FROM &&
      body.byteOffset === 0 &&
      body.byteLength === body.buffer.byteLength
    ) {
      options.transfer = [body.buffer];
    }
    return body;
  }
  const source = request.body;
  if (source === null) return null;
  if (length !== null) {
    return guard(source.getReader(), [], { bytes: 0, waited: 0 }, idle, stalled, abort);
  }
  // A body of unknown length, such as a chunked one, is read whole while it fits.
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
  const body = await readUnknown(source, config.streamThreshold, idle, stalled, abort);
  if (body instanceof ReadableStream) return body;
  if (body.byteLength === 0) return null;
  if (body.byteLength >= MOVE_FROM) options.transfer = [body.buffer];
  return body;
}

async function handle(
  ctx: Ctx,
  request: Bun.BunRequest<string>,
  server: Listener<SocketData>,
  target: Target,
): Promise<Response | undefined> {
  const { config } = ctx;
  const { need } = target;
  // A WebSocket upgrade is always a GET, as RFC 6455 says, so other methods skip the lookup.
  const upgrade =
    request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const limit = config.webSocket.maxConnections;
  // Upgrades in flight count with the open sockets, so that a burst can't pass the limit.
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
  if (upgrade && sockets.size + upgrades.size >= limit) {
    if (!refusing) {
      refusing = true;
      ctx.log.warn("refusing WebSocket upgrades", { maxConnections: limit });
    }
    return json(503, "RACK_OVERLOADED", "too many WebSockets are open");
  }
  const socket = upgrade ? `${ctx.slot.name}:${instance}:${++socketCount}` : undefined;
  if (socket !== undefined) upgrades.set(socket, undefined);
  // Bun's timer bounds a whole exchange; the panel bounds idle time with its streams instead.
  // @decision .agents/decisions/261118_071513-http-panel-device.md#requests
  const idle = config.idleTimeout;
  server.timeout(request, 0);
  // The client that goes away and a device that stops reading the body both cancel the call.
  const aborter = spareAborters.pop() ?? new AbortController();
  const waiting: Waiting = { request, aborter, attached: false, client: undefined, device: false };
  const stalled = waiting;
  watchClient(waiting);
  const options: CallOptions = { signal: aborter.signal, streamTimeout: idle * 1000 };
  let body: Bytes | ReadableStream<Uint8Array> | null;
  try {
    body = await bodyOf(request, config, stalled, options);
  } catch (error) {
    unwatchClient(waiting);
    if (socket !== undefined) release(socket);
    server.timeout(request, idle);
    return statusFor(ctx, target, error, stalled);
  }
  // Bun's params need no copy: the call clones its input as it sends it.
  const input: HttpInput = {
    method: request.method,
    url: request.url,
    headers: [...request.headers] as [string, string][],
    params: request.params as Record<string, string>,
    body,
  };
  if (socket !== undefined) input.socket = socket;
  let output: Awaited<ReturnType<Ctx["ports"][string]["handle"]>>;
  try {
    output = await (ctx.ports[need] as Ctx["ports"][string]).handle(input, options);
  } catch (error) {
    if (socket !== undefined) {
      // The device may have accepted the upgrade before the call failed, as when its client
      // left; a device forgets a socket that it never accepted, too.
      release(socket);
      unopened(ctx, need, socket);
    }
    server.timeout(request, idle);
    return statusFor(ctx, target, error, stalled);
  } finally {
    // From the head on, a client that goes away cancels the response's stream, and with it the
    // call; Bun cancels the stream itself.
    unwatchClient(waiting);
  }
  // The call has ended, and with it its listener on the controller, unless its response streams.
  if (
    !waiting.attached &&
    !aborter.signal.aborted &&
    !(body instanceof ReadableStream) &&
    !("body" in output && output.body instanceof ReadableStream) &&
    spareAborters.length < SPARE_ABORTERS
  ) {
    spareAborters.push(aborter);
  }
  if ("upgrade" in output) {
    if (socket === undefined) {
      server.timeout(request, idle);
      return json(502, "RACK_INVALID_OUTPUT", "the device upgraded a request that is no upgrade");
    }
    return upgradeTo(ctx, target, request, server, socket, output.upgrade);
  }
  if (socket !== undefined) release(socket);
  const answer = output.body;
  if (answer !== null && !(answer instanceof Uint8Array) && !(answer instanceof ReadableStream)) {
    server.timeout(request, idle);
    return fileAnswer(ctx, answer.file, output.status, output.headers);
  }
  const streamed = output.body instanceof ReadableStream;
  try {
    if (streamed) {
      // Bun sends a stream chunked, so its Content-Length can't go with it.
      const body = watched(output.body as ReadableStream<Uint8Array>, () =>
        server.timeout(request, idle),
      );
      return new Response(body, { status: output.status, headers: output.headers });
    }
    // A body sent whole keeps its Content-Length, in the form Bun sends fastest at its size.
    // @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#bodies-in-memory
    const response = wholeResponse(request, output.body as Uint8Array | null, {
      status: output.status,
      headers: output.headers,
    });
    server.timeout(request, idle);
    return response;
  } catch (error) {
    // The device returned headers that `Response` rejects, such as an invalid header name.
    server.timeout(request, idle);
    return invalidAnswer(ctx, target, error);
  }
}

/**
 * Upgrades a request that the device accepted. When the upgrade doesn't complete, because Bun
 * refuses it, the client left, or the device's answer has headers that HTTP refuses, the device
 * hears of it with `closed`, and the client gets an answer, with the connection's idle timer
 * back.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
 */
function upgradeTo(
  ctx: Ctx,
  target: Target,
  request: Bun.BunRequest<string>,
  server: Listener<SocketData>,
  socket: string,
  accepted: { protocol?: string | undefined; headers?: [string, string][] | undefined },
): Response | undefined {
  const idle = ctx.config.idleTimeout;
  const { need } = target;
  let upgraded: boolean;
  try {
    const headers = new Headers(accepted.headers ?? []);
    if (accepted.protocol !== undefined) headers.set("Sec-WebSocket-Protocol", accepted.protocol);
    upgraded = server.upgrade(request, { headers, data: { socket, need } });
  } catch (error) {
    release(socket);
    unopened(ctx, need, socket);
    server.timeout(request, idle);
    return invalidAnswer(ctx, target, error);
  }
  if (upgraded) {
    // The socket takes the place once it opens, which Bun may do within upgrade() itself; one
    // that never opens gives it back.
    if (upgrades.has(socket)) {
      upgrades.set(
        socket,
        setTimeout(() => {
          if (!upgrades.has(socket)) return;
          upgrades.delete(socket);
          unopened(ctx, need, socket);
        }, idle * 1000),
      );
    }
    return undefined;
  }
  release(socket);
  unopened(ctx, need, socket);
  server.timeout(request, idle);
  return json(400, "RACK_INVALID_INPUT", "the request can't be upgraded");
}

/** The answer for a response whose headers HTTP refuses, with the details in the log. */
function invalidAnswer(ctx: Ctx, target: Target, error: unknown): Response {
  warnSampled(ctx, `answer ${target.address}`, "a device's answer has headers that HTTP refuses", {
    route: target.address,
    error: messageOf(error),
  });
  return json(502, "RACK_INVALID_OUTPUT", GENERAL.RACK_INVALID_OUTPUT as string);
}

/**
 * Answers with a file that a device names by its path, from disk, with its `Content-Length` at
 * every size. A file that can't be read gets 502, and its path goes to the log, not to the client.
 *
 * @decision .agents/decisions/261119_205344-file-responses.md#fileresponse
 */
async function fileAnswer(
  ctx: Ctx,
  path: string,
  status: number,
  headers: [string, string][],
): Promise<Response> {
  if (!isAbsolute(path)) {
    return json(502, "RACK_INVALID_OUTPUT", "the file of a response must have an absolute path");
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${path} is not a file`);
    await access(path, constants.R_OK);
  } catch (error) {
    return unreadableFile(ctx, path, error);
  }
  try {
    return new Response(Bun.file(path), { status, headers });
  } catch (error) {
    // The device returned headers that `Response` rejects, such as an invalid header name.
    return json(502, "RACK_INVALID_OUTPUT", messageOf(error));
  }
}

/** The answer for a file of a response that can't be read, with the cause in the log. */
function unreadableFile(ctx: Ctx, path: string, error: unknown): Response {
  ctx.log.warn("the file of a response can't be read", { path, cause: messageOf(error) });
  return json(502, "RACK_DEVICE_FAULT", "the file of the response can't be read");
}

/** Closes a socket for a call of its device that failed. */
function closeFor(state: Socket, error: unknown): void {
  const code = codeOf(error);
  const overloaded = code === "RACK_LINK_DOWN" || code === "RACK_OVERLOADED";
  state.ws.close(overloaded ? 1013 : 1011, overloaded ? "try again later" : "internal error");
}

function run(ctx: Ctx, state: Socket, data: string | Bytes): Promise<void> {
  state.inFlight++;
  const port = ctx.ports[state.need] as Ctx["ports"][string];
  return port
    .message({ socket: state.ws.data.socket, data })
    .catch((error: unknown) => closeFor(state, error))
    .finally(() => {
      state.inFlight--;
      const next = state.held.shift();
      if (next !== undefined) void run(ctx, state, next);
      else if (state.paused && state.inFlight < MESSAGES_IN_FLIGHT) {
        state.paused = false;
        state.ws.resume();
      }
    });
}

/** Runs `action` on each socket of this panel that `ids` names; others are another panel's. */
function deliver(name: string, ids: string | string[], action: (ws: Socket["ws"]) => void): void {
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    if (!id.startsWith(`${name}:`)) continue;
    const state = sockets.get(id);
    if (state !== undefined) action(state.ws);
  }
}

/** Checks the panel's WebSockets with each device behind it; see `sockets` in `http/v2`. */
async function sync(ctx: Ctx): Promise<void> {
  const prefix = `${ctx.slot.name}:${instance}`;
  const byNeed = new Map<string, string[]>();
  for (const [id, state] of sockets) {
    if (!state.opened) continue;
    const list = byNeed.get(state.need) ?? [];
    list.push(id);
    byNeed.set(state.need, list);
  }
  await Promise.all(
    [...byNeed].map(async ([need, open]) => {
      const port = ctx.ports[need] as Ctx["ports"][string];
      let unknown: string[];
      try {
        ({ unknown } = await port.sockets({ instance: prefix, open }));
      } catch {
        // The need's counters count the failure, and the next check tries again.
        return;
      }
      const lost = new Set(unknown);
      for (const id of open) {
        const state = sockets.get(id);
        if (state === undefined) continue;
        if (!lost.has(id)) state.unknown = 0;
        else if (++state.unknown >= 2) state.ws.close(1011, "the device lost the socket");
      }
    }),
  );
}

/** Reads a certificate file: a path relative to the base directory, or an absolute one. */
async function readPair(path: string, ctx: Ctx): Promise<string> {
  return await Bun.file(resolve(ctx.baseDir, path)).text();
}

/** Checks the certificate files, and replaces the pairs that changed and load. */
async function checkCertificates(ctx: Ctx): Promise<void> {
  if (listener === undefined) return;
  let changed = false;
  const next: Loaded[] = [];
  for (const pair of loaded) {
    let cert: string;
    let key: string;
    try {
      [cert, key] = await Promise.all([readPair(pair.certPath, ctx), readPair(pair.keyPath, ctx)]);
    } catch (error) {
      ctx.log.warn("certificate files can't be read", {
        cert: pair.certPath,
        error: messageOf(error),
      });
      next.push(pair);
      continue;
    }
    if (cert === pair.cert && key === pair.key) {
      next.push({ ...pair, bad: undefined });
      continue;
    }
    if (pairLoads(cert, key)) {
      next.push({ ...pair, cert, key, bad: undefined });
      changed = true;
      continue;
    }
    // A renewal that writes the certificate and the key one after the other gets one more check.
    const seen = pair.bad?.cert === cert && pair.bad.key === key ? pair.bad.seen + 1 : 1;
    if (seen === 2) {
      ctx.log.error("certificates rejected", {
        url: listener.url.href,
        cert: pair.certPath,
        error: "the certificate and the key don't load together",
      });
    }
    next.push({ ...pair, bad: { cert, key, seen } });
  }
  if (changed) {
    try {
      await listener.setTls(tlsOf(next));
    } catch {
      // setTls() logged the rejection; the old pairs stay, and the next change tries again.
      return;
    }
  }
  loaded = next;
}

/** The standard HTTP panel. */
export default device({
  model: "http-panel",
  config: PanelConfig,
  needs: routeNeeds,
  async powerOn(ctx) {
    const { config } = ctx;
    for (const need of Object.keys(ctx.ports)) {
      const events = ctx.on[need] as Ctx["on"][string];
      events.send(({ socket, data }) => deliver(ctx.slot.name, socket, (ws) => ws.send(data)));
      events.close(({ socket, code, reason }) =>
        deliver(ctx.slot.name, socket, (ws) => ws.close(code ?? 1000, reason ?? "")),
      );
    }
    const pairs =
      config.tls === undefined ? [] : Array.isArray(config.tls) ? config.tls : [config.tls];
    loaded = await Promise.all(
      pairs.map(async (pair) => ({
        certPath: pair.cert,
        keyPath: pair.key,
        serverName: pair.serverName,
        cert: await readPair(pair.cert, ctx),
        key: await readPair(pair.key, ctx),
        bad: undefined,
      })),
    );
    const routes: Record<
      string,
      (request: Bun.BunRequest<string>, l: Listener<SocketData>) => Promise<Response | undefined>
    > = {};
    for (const [pattern, address] of Object.entries(config.routes)) {
      const target: Target = { need: needName(address), address };
      routes[pattern] = (request, served) => handle(ctx, request, served, target);
    }
    listener = await ctx.serve<SocketData>({
      hostname: config.hostname,
      port: config.port,
      maxRequestBodySize: config.maxBodySize,
      idleTimeout: config.idleTimeout,
      ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
      ...(loaded.length === 0 ? {} : { tls: tlsOf(loaded) }),
      routes,
      fetch: () => json(404, "RACK_NO_ROUTE", "no route matches"),
      // Bun opens a file body once the handler has returned, and reports here a file that went
      // away after fileAnswer() checked it.
      // @decision .agents/decisions/261119_205344-file-responses.md#failure-modes
      error(error) {
        const path = (error as { path?: unknown }).path;
        if (typeof path === "string") return unreadableFile(ctx, path, error);
        ctx.log.error("a request handler failed", { error: messageOf(error) });
        return new Response("Internal Server Error", { status: 500 });
      },
      websocket: {
        maxPayloadLength: config.webSocket.maxMessageSize,
        open(ws) {
          const { socket, need } = ws.data;
          release(socket);
          const state: Socket = {
            ws,
            need,
            opened: false,
            inFlight: 0,
            held: [],
            paused: false,
            unknown: 0,
          };
          sockets.set(socket, state);
          const port = ctx.ports[need] as Ctx["ports"][string];
          void port.opened({ socket }).then(
            () => {
              state.opened = true;
            },
            (error: unknown) => closeFor(state, error),
          );
        },
        message(ws, message) {
          const state = sockets.get(ws.data.socket);
          if (state === undefined) return;
          const data: string | Bytes =
            typeof message === "string" ? message : new Uint8Array(message);
          if (state.inFlight >= MESSAGES_IN_FLIGHT || state.held.length > 0) {
            state.held.push(data);
            if (!state.paused) {
              state.paused = true;
              ws.pause();
            }
            return;
          }
          return run(ctx, state, data);
        },
        close(ws, code, reason) {
          const { socket, need } = ws.data;
          const state = sockets.get(socket);
          sockets.delete(socket);
          if (state !== undefined) state.held = [];
          if (refusing && sockets.size + upgrades.size < config.webSocket.maxConnections) {
            refusing = false;
            ctx.log.info("accepting WebSocket upgrades again");
          }
          const port = ctx.ports[need] as Ctx["ports"][string];
          // A failed closed call is only counted, by the need's counters.
          void port.closed({ socket, code, reason }).catch(() => undefined);
        },
      },
    });
    return {};
  },
  activate(ctx, scope) {
    if (loaded.length > 0) {
      scope.every(ctx.config.certificateCheck * 1000, () => checkCertificates(ctx));
    }
    scope.every(SYNC_MS, () => sync(ctx));
  },
});
