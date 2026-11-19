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
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { resolve } from "node:path";
import {
  type CallOptions,
  type DeviceContext,
  device,
  type Listener,
  type ListenerTls,
  patched,
  RackError,
} from "rack42u";
import { Http } from "rack42u/std";
import * as v from "valibot";

const MiB = 1024 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;
/**
 * The default largest request body, of a declared length, that goes to the device as bytes: a
 * stream's window, which a stream of a body that size would fill at once anyway.
 */
const STREAM_THRESHOLD = 256 * 1024;
const LATE = Symbol("late");
/** The message of the 408 for a body sent whole that didn't arrive within `idleTimeout`. */
const LATE_BODY = "the client didn't send its body within idleTimeout";
/** The most message calls a socket has unfinished. */
const MESSAGES_IN_FLIGHT = 16;
/**
 * How often the panel checks its WebSockets with the devices behind it: every 30 s. Tests
 * shorten it through the environment, which a Worker copies as it starts, so as not to wait.
 * Exported for the tests of its default.
 */
export const SYNC_MS = Number(process.env.RACK42U_TEST_PANEL_SYNC_MS) || 30_000;

const whole = (low: number, high: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(low), v.maxValue(high));
const Pair = v.object({ cert: v.string(), key: v.string(), serverName: v.optional(v.string()) });

/**
 * The configuration of the panel, with its defaults; `HttpPanelConfig` in `rack42u/std`
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
let socketCount = 0;
let refusing = false;
let listener: Listener<SocketData> | undefined;
let loaded: Loaded[] = [];

/**
 * How long a call waits for its response head before the panel reads its client's signal: one
 * to two ticks of 100 ms.
 */
const SIGNAL_TICK_MS = 100;

/** A call that waits for its response head, and the controller that cancels it. */
interface Waiting {
  request: Request;
  aborter: AbortController;
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
  for (const { request, aborter } of due) {
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

/** Why a request failed, as a status: what the decision's table of statuses says. */
function statusFor(error: unknown, stalled: { client: boolean; device: boolean }): Response {
  const message = messageOf(error);
  if (stalled.client) {
    const whole = error instanceof RackError && error.message === LATE_BODY;
    return json(408, "RACK_TIMEOUT", whole ? LATE_BODY : "the client stopped sending its body");
  }
  if (stalled.device) return json(504, "RACK_TIMEOUT", "the device stopped reading the body");
  const code = codeOf(error);
  if (code === "RACK_LINK_DOWN" || code === "RACK_OVERLOADED") return json(503, code, message);
  if (code === "RACK_TIMEOUT") return json(504, code, message);
  return json(502, code, message);
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
async function readWhole(
  request: Request,
  idle: number,
  stalled: { client: boolean },
): Promise<Bytes> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), idle * 1000);
  });
  const reading = request.bytes() as Promise<Bytes>;
  try {
    const bytes = await Promise.race([reading, late]);
    if (bytes === LATE) {
      stalled.client = true;
      // Bun fails the read once the panel answers; nothing waits for it any more.
      reading.catch(() => undefined);
      throw new RackError("RACK_TIMEOUT", LATE_BODY);
    }
    return bytes;
  } catch (error) {
    throw error instanceof RackError ? error : bodyError(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The request body as the panel streams it on: a stream that fails with `RACK_TIMEOUT` when the
 * client sends nothing for `idle` s, and with `RACK_INVALID_INPUT` when it crosses the limit.
 *
 * The stream to the device times out after the same time at both of its ends, whichever party
 * stalled. So when it is cancelled with `RACK_TIMEOUT`, the stall is the client's if the panel
 * was waiting for the client's bytes, and the device's if it was waiting for the device to take
 * them; only then does the panel give up the call.
 */
function guard(
  source: ReadableStream<Uint8Array>,
  idle: number,
  stalled: { client: boolean; device: boolean },
  abort: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let waiting = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const quiet = new Promise<"quiet">((resolve) => {
          timer = setTimeout(() => resolve("quiet"), idle * 1000);
        });
        waiting = true;
        try {
          const next = await Promise.race([reader.read(), quiet]);
          if (next === "quiet") {
            stalled.client = true;
            void reader.cancel().catch(() => undefined);
            controller.error(new RackError("RACK_TIMEOUT", "the client stopped sending its body"));
            return;
          }
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(bodyError(error));
        } finally {
          waiting = false;
          clearTimeout(timer);
        }
      },
      cancel(reason) {
        if (reason instanceof RackError && reason.code === "RACK_TIMEOUT" && !stalled.client) {
          if (waiting) stalled.client = true;
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

async function handle(
  ctx: Ctx,
  request: Bun.BunRequest<string>,
  server: Listener<SocketData>,
  need: string,
): Promise<Response | undefined> {
  const { config } = ctx;
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const limit = config.webSocket.maxConnections;
  if (upgrade && sockets.size >= limit) {
    if (!refusing) {
      refusing = true;
      ctx.log.warn("refusing WebSocket upgrades", { maxConnections: limit });
    }
    return json(503, "RACK_OVERLOADED", `${limit} WebSockets are open`);
  }
  // Bun's timer bounds a whole exchange; the panel bounds idle time with its streams instead.
  // @decision .agents/decisions/261118_071513-http-panel-device.md#requests
  server.timeout(request, 0);
  const restore = () => server.timeout(request, config.idleTimeout);
  const stalled = { client: false, device: false };
  // The client that goes away and a device that stops reading the body both cancel the call.
  const aborter = new AbortController();
  const waiting: Waiting = { request, aborter };
  watchClient(waiting);
  const options: CallOptions = { signal: aborter.signal, streamTimeout: config.idleTimeout * 1000 };
  let body: Bytes | ReadableStream<Uint8Array> | null = null;
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
    const length = request.headers.get("content-length");
    if (length !== null && Number(length) <= config.streamThreshold) {
      try {
        body = await readWhole(request, config.idleTimeout, stalled);
      } catch (error) {
        unwatchClient(waiting);
        restore();
        return statusFor(error, stalled);
      }
      // Bun's bytes() gives a buffer of its own, as measured on Linux; the call moves it.
      if (body.byteOffset === 0 && body.byteLength === body.buffer.byteLength) {
        options.transfer = [body.buffer];
      }
    } else body = guard(request.body, config.idleTimeout, stalled, () => aborter.abort());
  }
  const socket = upgrade ? `${ctx.slot.name}:${instance}:${++socketCount}` : undefined;
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => {
    headers.push([name, value]);
  });
  const input = {
    method: request.method,
    url: request.url,
    headers,
    params: { ...request.params } as Record<string, string>,
    body,
    ...(socket === undefined ? {} : { socket }),
  };
  let output: Awaited<ReturnType<Ctx["ports"][string]["handle"]>>;
  try {
    output = await (ctx.ports[need] as Ctx["ports"][string]).handle(input, options);
  } catch (error) {
    restore();
    return statusFor(error, stalled);
  } finally {
    // From the head on, a client that goes away cancels the response's stream, and with it the
    // call; Bun cancels the stream itself.
    unwatchClient(waiting);
  }
  if ("upgrade" in output) {
    if (socket === undefined) {
      restore();
      return json(502, "RACK_INVALID_OUTPUT", "the device upgraded a request that is no upgrade");
    }
    const headers = new Headers(output.upgrade.headers ?? []);
    if (output.upgrade.protocol !== undefined) {
      headers.set("Sec-WebSocket-Protocol", output.upgrade.protocol);
    }
    if (server.upgrade(request, { headers, data: { socket, need } })) return undefined;
    restore();
    return json(400, "RACK_INVALID_INPUT", "the request can't be upgraded");
  }
  const streamed = output.body instanceof ReadableStream;
  try {
    const responseBody = streamed
      ? watched(output.body as ReadableStream<Uint8Array>, restore)
      : (output.body as Uint8Array | null);
    const response = new Response(responseBody, { status: output.status, headers: output.headers });
    if (!streamed) restore();
    return response;
  } catch (error) {
    // The device returned headers that `Response` rejects, such as an invalid header name.
    restore();
    return json(502, "RACK_INVALID_OUTPUT", messageOf(error));
  }
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
      const need = needName(address);
      routes[pattern] = (request, served) => handle(ctx, request, served, need);
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
      websocket: {
        maxPayloadLength: config.webSocket.maxMessageSize,
        open(ws) {
          const { socket, need } = ws.data;
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
          if (refusing && sockets.size < config.webSocket.maxConnections) {
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
