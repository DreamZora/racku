/**
 * The `http/v2` connector, through which a panel such as the standard HTTP panel passes
 * requests and WebSocket messages to a device, and `httpHandler`, which adapts fetch-style
 * handlers, WebSocket included, into an implementation of it.
 *
 * @decision .agents/decisions/261118_071513-http-panel-device.md#the-connector
 * @decision .agents/decisions/261118_071513-http-panel-device.md#websocket
 */
import * as v from "valibot";
import { connector, event, rpc, stream } from "../connector.ts";
import type { CallContext, PortEmitter, PortImpl } from "../device.ts";
import { RackError } from "../errors.ts";

const Header = v.tuple([v.string(), v.string()]);
const Body = v.nullable(v.union([v.instance(Uint8Array), stream()]));
const Data = v.union([v.string(), v.instance(Uint8Array)]);
const Targets = v.union([v.string(), v.array(v.string())]);

/** The request a panel sends through `http/v2`. */
export const HttpRequest = v.object({
  method: v.string(),
  url: v.string(),
  // Pairs instead of a record, so duplicate headers survive.
  headers: v.array(Header),
  params: v.record(v.string(), v.string()),
  /** `null`, the bytes, or a stream of them. */
  body: Body,
  /** For a WebSocket upgrade: the id the panel gives the socket. */
  socket: v.optional(v.string()),
});

/** The response a device returns through `http/v2`, or its acceptance of an upgrade. */
export const HttpResponse = v.union([
  v.object({
    // `Response` accepts only these statuses.
    status: v.pipe(v.number(), v.integer(), v.minValue(200), v.maxValue(599)),
    headers: v.array(Header),
    body: Body,
  }),
  v.object({
    upgrade: v.object({ protocol: v.optional(v.string()), headers: v.optional(v.array(Header)) }),
  }),
]);

/**
 * The `http/v2` connector: `handle` per HTTP request; `opened`, `message`, and `closed` per
 * WebSocket; `sockets`, with which a panel checks which of its WebSockets a device knows; and the
 * events `send` and `close`, which reach the panel's WebSockets.
 */
export const Http = connector("http/v2", {
  handle: rpc(HttpRequest, HttpResponse),
  opened: rpc(v.object({ socket: v.string() }), v.undefined()),
  message: rpc(v.object({ socket: v.string(), data: Data }), v.undefined()),
  closed: rpc(
    v.object({ socket: v.string(), code: v.number(), reason: v.string() }),
    v.undefined(),
  ),
  sockets: rpc(
    v.object({ instance: v.string(), open: v.array(v.string()) }),
    v.object({ unknown: v.array(v.string()) }),
  ),
  send: event(v.object({ socket: Targets, data: Data })),
  close: event(
    v.object({ socket: Targets, code: v.optional(v.number()), reason: v.optional(v.string()) }),
  ),
});

type HttpMembers = typeof Http.members;

/** A fetch-style request handler, such as the `fetch` of a routing library. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** What `fetch` gets beside the request, as Bun's `Server`. */
export interface HttpServer<T = unknown> {
  /**
   * Accepts a WebSocket upgrade: Bun's options, and `protocol`, the subprotocol it accepts,
   * which Bun's own `upgrade()` doesn't have.
   *
   * @returns `true` for a request that the panel passed as an upgrade; `fetch` then returns
   *   nothing.
   */
  upgrade(
    request: Request,
    options?: { headers?: ConstructorParameters<typeof Headers>[0]; data?: T; protocol?: string },
  ): boolean;
}

/** A WebSocket that a panel holds for the device. */
export interface HttpSocket<T = unknown> {
  /** The id the panel gave it: `<panel>:<instance>:<n>`. */
  readonly id: string;
  /** Per-socket state, from `upgrade()`; `list()` and `restore()` carry it across swaps. */
  data: T;
  /** Sends a message, as a `send` event of the port. */
  send(data: string | Uint8Array): void;
  /** Closes the socket, as a `close` event of the port. */
  close(code?: number, reason?: string): void;
}

/** The handlers `httpHandler` adapts. */
export interface HttpHandlers<T = unknown> {
  /** Handles a request; for an upgrade it calls `server.upgrade()` and returns nothing. */
  fetch(
    request: Request,
    server: HttpServer<T>,
  ): Response | undefined | Promise<Response | undefined>;
  websocket?: {
    open?(ws: HttpSocket<T>): void | Promise<void>;
    message?(ws: HttpSocket<T>, data: string | Uint8Array): void | Promise<void>;
    close?(ws: HttpSocket<T>, code: number, reason: string): void | Promise<void>;
  };
}

/** A socket and its data, as {@link HttpHandler.list} returns them for a device's `snapshot`. */
export interface HttpSocketState<T = unknown> {
  socket: string;
  data: T;
}

/** An implementation of `http/v2`, with the sockets it knows. */
export interface HttpHandler<T = unknown> extends PortImpl<HttpMembers> {
  /** The sockets it knows, with their data, for the device's `snapshot`. */
  list(): HttpSocketState<T>[];
  /** Takes sockets back, in the device's `restore`, so that they work across a swap. */
  restore(list: readonly HttpSocketState<T>[]): void;
}

/** Bodies up to this size go in one message; larger or slower ones stream. */
const SMALL = 64 * 1024;
/**
 * How long a panel instance may stay silent before its sockets count as gone: three of the
 * panel's checks, 90 s. Tests shorten the checks through the environment, as the panel does.
 */
const SILENT_MS = 3 * (Number(process.env.RACK42U_TEST_PANEL_SYNC_MS) || 30_000);
const LATER = Symbol("later");

type Bytes = Uint8Array<ArrayBuffer>;
type Read = { done: boolean; value?: Uint8Array | undefined };
/** A reader of a body; the stream types of Bun and of `node:stream/web` both fit it. */
type Reader = { read(): Promise<Read>; cancel(reason?: unknown): Promise<void> };

interface Entry<T> {
  ws: HttpSocket<T>;
  /** `sockets` calls in a row from its panel instance that left it out. */
  missed: number;
}

/** The panel instance of a socket id: `<panel>:<instance>`. */
function instanceOf(id: string): string {
  const first = id.indexOf(":");
  const second = id.indexOf(":", first + 1);
  return second < 0 ? id : id.slice(0, second);
}

function pairsOf(headers: Headers): [string, string][] {
  const pairs: [string, string][] = [];
  headers.forEach((value, name) => {
    if (name !== "set-cookie") pairs.push([name, value]);
  });
  for (const cookie of headers.getSetCookie()) pairs.push(["set-cookie", cookie]);
  return pairs;
}

/**
 * The body of a response: `null`, its bytes when it ends within 64 KiB without waiting, or a
 * stream otherwise, so that a large or slow body, such as server-sent events, starts at once.
 */
async function bodyOf(response: Response): Promise<Bytes | ReadableStream<Uint8Array> | null> {
  const body = response.body;
  if (body === null) return null;
  const reader: Reader = body.getReader();
  const taken: Uint8Array[] = [];
  let size = 0;
  // One turn of the event loop: the chunks that arrive before it are the body's at once.
  const later = new Promise<typeof LATER>((resolve) => setImmediate(() => resolve(LATER)));
  for (;;) {
    const next: Promise<Read> = reader.read();
    const first = await Promise.race([next, later]);
    if (first === LATER) return rest(taken, reader, next);
    if (first.done) break;
    const chunk = first.value as unknown;
    if (!(chunk instanceof Uint8Array)) {
      throw new RackError("RACK_INVALID_OUTPUT", "a response body chunk must be a Uint8Array");
    }
    taken.push(chunk);
    size += chunk.byteLength;
    if (size > SMALL) return rest(taken, reader, undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of taken) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A stream of the chunks read so far, then of what the reader still gives. */
function rest(
  taken: Uint8Array[],
  reader: Reader,
  pending: Promise<Read> | undefined,
): ReadableStream<Uint8Array> {
  let waiting = pending;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunk = taken.shift();
        if (chunk !== undefined) {
          controller.enqueue(chunk);
          return;
        }
        const next: Read = await (waiting ?? reader.read());
        waiting = undefined;
        if (next.done || next.value === undefined) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/**
 * Wraps fetch-style handlers into an implementation of `http/v2`.
 *
 * `fetch` receives a standard `Request`, whose `signal` aborts when the client goes away or the
 * call times out, and whose body streams when the panel streams it. A `Response` whose body
 * ends at once within 64 KiB goes back in one message; any other body streams, so server-sent
 * events and large downloads work. With `websocket`, `fetch` accepts an upgrade with
 * `server.upgrade(request, options)`; the sockets' `send()` and `close()` travel as the events
 * of `emit`, the port's emitter.
 *
 * The handler answers the panel's `sockets` calls itself: it treats a socket as closed once two
 * calls in a row from its panel instance left it out, or once that instance has made no call for
 * 90 s, as after a crash of the panel, and runs `websocket.close` for it with 1006. It checks for
 * silence at each call it gets, of any member. A message for a socket it doesn't know closes
 * that socket with 1011.
 *
 * @param handlers A fetch-style function, or `fetch` with WebSocket handlers.
 * @param emit `ctx.emit.<port>` of the port, needed for WebSockets.
 * @returns The port implementation to return from `powerOn`, with `list()` and `restore()`.
 * @decision .agents/decisions/261118_071513-http-panel-device.md#the-connector
 */
export function httpHandler<T = unknown>(
  handlers: FetchHandler | HttpHandlers<T>,
  emit?: PortEmitter<HttpMembers>,
): HttpHandler<T> {
  const options: HttpHandlers<T> =
    typeof handlers === "function" ? { fetch: (request) => handlers(request) } : handlers;
  const sockets = new Map<string, Entry<T>>();
  /** Sockets upgraded and not opened yet, with their data. */
  const upgrading = new Map<string, T>();
  /** How many of `sockets` each panel instance holds. */
  const held = new Map<string, number>();
  /** When each panel instance last made a call that named it or one of its sockets. */
  const heard = new Map<string, number>();
  /** When this instance started, or took sockets back: silence counts from then. */
  let since = Date.now();

  const hear = (instance: string) => heard.set(instance, Date.now());
  const add = (id: string, entry: Entry<T>) => {
    if (!sockets.has(id)) {
      const instance = instanceOf(id);
      held.set(instance, (held.get(instance) ?? 0) + 1);
    }
    sockets.set(id, entry);
  };
  const remove = (id: string): Entry<T> | undefined => {
    const entry = sockets.get(id);
    if (entry === undefined) return undefined;
    sockets.delete(id);
    const instance = instanceOf(id);
    const left = (held.get(instance) ?? 1) - 1;
    if (left > 0) held.set(instance, left);
    else held.delete(instance);
    return entry;
  };

  const socketOf = (id: string, data: T): HttpSocket<T> => {
    const ws: HttpSocket<T> = {
      id,
      data,
      send(message) {
        // The schema accepts any string or bytes; a send that finds no panel is dropped, as
        // any event to a consumer that is gone.
        const data = typeof message === "string" ? message : (message as Bytes);
        void emit?.send({ socket: id, data }).catch(() => undefined);
      },
      close(code, reason) {
        const payload: { socket: string; code?: number; reason?: string } = { socket: id };
        if (code !== undefined) payload.code = code;
        if (reason !== undefined) payload.reason = reason;
        // As for send: a close that finds no panel is dropped.
        void emit?.close(payload).catch(() => undefined);
      },
    };
    return ws;
  };

  /**
   * Runs the close handler with 1006 for each socket that `ids` names and the handler still
   * holds. Every handler runs; the first that throws fails the call that found the sockets lost.
   */
  const lose = async (ids: readonly string[]): Promise<void> => {
    let failed: { error: unknown } | undefined;
    for (const id of ids) {
      const entry = remove(id);
      if (entry === undefined) continue;
      try {
        await options.websocket?.close?.(entry.ws, 1006, "abnormal closure");
      } catch (error) {
        failed ??= { error };
      }
    }
    if (failed !== undefined) throw failed.error;
  };

  /**
   * Treats the sockets of each panel instance that has been silent for `SILENT_MS` as closed.
   * Every call checks, so a device forgets the sockets of a panel that crashed at its first call
   * after that time, whether a panel's `sockets` call, a request, or a message brings it. It
   * returns nothing when no instance is silent, so that a call goes on without waiting.
   */
  const sweep = (): Promise<void> | undefined => {
    const now = Date.now();
    const silent = new Set<string>();
    for (const instance of held.keys()) {
      if (now - (heard.get(instance) ?? since) > SILENT_MS) silent.add(instance);
    }
    for (const [instance, at] of heard) {
      if (!held.has(instance) && now - at > SILENT_MS) heard.delete(instance);
    }
    if (silent.size === 0) return undefined;
    return lose([...sockets.keys()].filter((id) => silent.has(instanceOf(id))));
  };

  const implementation: HttpHandler<T> = {
    async handle(input, call: CallContext) {
      if (input.socket !== undefined) hear(instanceOf(input.socket));
      const init: RequestInit & { duplex?: "half" } = {
        method: input.method,
        headers: input.headers,
        signal: call.signal,
      };
      if (input.body !== null) {
        init.body = input.body as RequestInit["body"];
        if (input.body instanceof ReadableStream) init.duplex = "half";
      }
      const request = new Request(input.url, init);
      const swept = sweep();
      if (swept !== undefined) await swept;
      let upgraded: { data: T; protocol?: string; headers?: [string, string][] } | undefined;
      const server: HttpServer<T> = {
        upgrade(target, upgrade = {}) {
          if (target !== request || input.socket === undefined || upgraded !== undefined) {
            return false;
          }
          upgraded = { data: upgrade.data as T };
          if (upgrade.protocol !== undefined) upgraded.protocol = upgrade.protocol;
          if (upgrade.headers !== undefined)
            upgraded.headers = pairsOf(new Headers(upgrade.headers));
          return true;
        },
      };
      const response = await options.fetch(request, server);
      if (upgraded !== undefined && input.socket !== undefined) {
        if (options.websocket === undefined || emit === undefined) {
          throw new RackError(
            "RACK_INVALID_OUTPUT",
            "an upgrade needs websocket handlers and the port's emitter in httpHandler()",
          );
        }
        upgrading.set(input.socket, upgraded.data);
        const accepted: { protocol?: string; headers?: [string, string][] } = {};
        if (upgraded.protocol !== undefined) accepted.protocol = upgraded.protocol;
        if (upgraded.headers !== undefined) accepted.headers = upgraded.headers;
        return { upgrade: accepted };
      }
      if (response === undefined) {
        throw new RackError("RACK_INVALID_OUTPUT", "fetch returned no response");
      }
      const body = await bodyOf(response);
      return { status: response.status, headers: pairsOf(response.headers), body };
    },
    async opened({ socket }) {
      hear(instanceOf(socket));
      const swept = sweep();
      if (swept !== undefined) await swept;
      const data = upgrading.get(socket) as T;
      upgrading.delete(socket);
      const ws = socketOf(socket, data);
      add(socket, { ws, missed: 0 });
      await options.websocket?.open?.(ws);
    },
    async message({ socket, data }) {
      hear(instanceOf(socket));
      const swept = sweep();
      if (swept !== undefined) await swept;
      const entry = sockets.get(socket);
      if (entry === undefined) {
        // The device lost the socket, as after a reset; the client reconnects.
        socketOf(socket, undefined as T).close(1011, "unknown socket");
        return;
      }
      await options.websocket?.message?.(entry.ws, data);
    },
    async closed({ socket, code, reason }) {
      hear(instanceOf(socket));
      upgrading.delete(socket);
      const entry = remove(socket);
      if (entry !== undefined) await options.websocket?.close?.(entry.ws, code, reason);
      const swept = sweep();
      if (swept !== undefined) await swept;
    },
    async sockets({ instance, open }) {
      hear(instance);
      const listed = new Set(open);
      const unknown = open.filter((id) => !sockets.has(id) && !upgrading.has(id));
      const gone: string[] = [];
      for (const [id, entry] of sockets) {
        if (instanceOf(id) !== instance) continue;
        if (listed.has(id)) entry.missed = 0;
        else if (++entry.missed >= 2) gone.push(id);
      }
      await lose(gone);
      const swept = sweep();
      if (swept !== undefined) await swept;
      return { unknown };
    },
    list: () => [...sockets].map(([socket, entry]) => ({ socket, data: entry.ws.data })),
    restore(list) {
      since = Date.now();
      for (const { socket, data } of list) add(socket, { ws: socketOf(socket, data), missed: 0 });
    },
  };
  return implementation;
}
