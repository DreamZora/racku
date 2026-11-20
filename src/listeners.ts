/**
 * Listeners in the Worker host: the HTTP servers, WebSocket included, that a device opens with
 * `ctx.serve`, and that the rack hands over across swaps.
 *
 * A device declares its listeners in `powerOn`. The host checks their options and certificates
 * and reserves their addresses with the rack, but binds them only when the rack puts the
 * instance into service, always with `reusePort`, so that a new instance can bind before the
 * old one stops. Requests that arrive before the instance is installed wait here. When the
 * instance leaves service, its servers stop listening, and its WebSockets close once the
 * messages in flight on them have been handled.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#listeners
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#defaults-and-bounds
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#port-0
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#conflicts
 * @decision .agents/decisions/261119_205344-file-responses.md#fileresponse
 */
import { X509Certificate } from "node:crypto";
import { resolve } from "node:path";
import type { LogLevel } from "./device.ts";
import { fromWireError, RackError, toWireError, type WireError } from "./errors.ts";
import {
  type CertificateInfo,
  type InheritedListener,
  LISTENER_LIMIT,
  type ListenerReport,
  type ReserveAsk,
} from "./protocol.ts";

const MiB = 1024 * 1024;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_BODY = MiB;
const DEFAULT_IDLE = 10;
const DEFAULT_WS_PAYLOAD = MiB;
const DEFAULT_WS_IDLE = 120;
const DEFAULT_WS_BUFFERED = MiB;
/** How often the counters in shared memory catch up with Bun's, for what no event reports. */
const TICK_MS = 100;

/** A certificate and its key in PEM, for a listener. */
export interface ListenerTls {
  cert: string | ArrayBufferView | Blob;
  key: string | ArrayBufferView | Blob;
  /** The server name the pair serves; each pair in a list for SNI names one. */
  serverName?: string;
  /** The passphrase of an encrypted key. */
  passphrase?: string;
}

/** The WebSocket handlers and limits of a listener. */
export interface ListenerWebSocket<T = unknown> {
  open?(ws: Bun.ServerWebSocket<T>): void | Promise<void>;
  /**
   * A message from the client. After the instance leaves service, the WebSocket closes once
   * every call of this handler has returned.
   */
  message?(ws: Bun.ServerWebSocket<T>, message: string | Buffer<ArrayBuffer>): void | Promise<void>;
  close?(ws: Bun.ServerWebSocket<T>, code: number, reason: string): void | Promise<void>;
  drain?(ws: Bun.ServerWebSocket<T>): void | Promise<void>;
  ping?(ws: Bun.ServerWebSocket<T>, data: Buffer): void | Promise<void>;
  pong?(ws: Bun.ServerWebSocket<T>, data: Buffer): void | Promise<void>;
  /** The largest message a client may send, in bytes; default 1 MiB. Larger ones close it with 1009. */
  maxPayloadLength?: number;
  /** Seconds a WebSocket may idle, 8 to 960; default 120, with pings. */
  idleTimeout?: number;
  /**
   * Bytes a WebSocket may have unsent; default 1 MiB. A WebSocket that has more when the device
   * sends to it closes with 1013, "try again later".
   */
  maxBuffered?: number;
}

/** A handler of a listener's requests. It returns nothing for a request it upgraded. */
export type ListenerHandler<T = unknown> = (
  request: Request,
  listener: Listener<T>,
) => Response | undefined | Promise<Response | undefined>;

/** A handler of a route, which also gets the route's parameters as `request.params`. */
export type ListenerRouteHandler<T = unknown> = (
  request: Bun.BunRequest<string>,
  listener: Listener<T>,
) => Response | undefined | Promise<Response | undefined>;

/** HTTP methods that a route may map to handlers of their own. */
export type ListenerMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

/** What a route answers with: a handler, a `Response`, or one of those per method. */
export type ListenerRoute<T = unknown> =
  | Response
  | ListenerRouteHandler<T>
  | Partial<Record<ListenerMethod, ListenerRouteHandler<T> | Response>>;

/** The handlers of a listener, which {@link Listener.reload} replaces. */
export interface ListenerHandlers<T = unknown> {
  /** Handles the requests that no route matches; without it, they get 404. */
  fetch?: ListenerHandler<T>;
  /** Bun route patterns, such as `/orders/:id` and `/api/*`. */
  routes?: Record<string, ListenerRoute<T>>;
  /** Turns an error that a handler threw into a response; Bun answers 500 without it. */
  error?: (error: Error) => Response | Promise<Response>;
  websocket?: ListenerWebSocket<T>;
}

/**
 * The options of `ctx.serve`: those of `Bun.serve` that a device needs, and `allowedHosts`.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#defaults-and-bounds
 */
export interface ServeOptions<T = unknown> extends ListenerHandlers<T> {
  /** 0 to 65 535; 0 picks a free port, which the device keeps while the rack runs. */
  port: number;
  /** The address to listen on; default `127.0.0.1`. */
  hostname?: string;
  /** The largest request body, in bytes; default 1 MiB. A larger one gets 413. */
  maxRequestBodySize?: number;
  /**
   * Seconds, 1 to 255; default 10. Bun closes a keep-alive connection idle that long, and also
   * cuts a request whose whole exchange takes longer: traffic doesn't extend it. Bun applies it
   * in steps of 4 s.
   */
  idleTimeout?: number;
  /** A certificate and key, or a list of them for SNI; without it, the listener speaks HTTP. */
  tls?: ListenerTls | ListenerTls[];
  /**
   * More host names that clients may send as `Host` to a listener on a loopback hostname,
   * besides the hostname and `localhost`; requests for other hosts get 403.
   */
  allowedHosts?: string[];
}

/**
 * A listener, as `ctx.serve` resolves with it and as its handlers receive it, where `Bun.serve`
 * passes its server. Listening and stopping belong to the rack.
 */
export interface Listener<T = unknown> {
  /** Where the listener listens; final from `serve()` on, also for port 0. */
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  /** Upgrades a request to a WebSocket on the server that took it, as Bun's `upgrade()`. */
  upgrade(
    request: Request,
    options?: { headers?: ConstructorParameters<typeof Headers>[0]; data?: T },
  ): boolean;
  /** Sets the idle timeout of a request's connection, in seconds, as Bun's `timeout()`. */
  timeout(request: Request, seconds: number): void;
  /** The address of a request's client, as Bun's `requestIP()`. */
  requestIP(request: Request): Bun.SocketAddress | null;
  /**
   * Publishes to a topic on every server of the listener. Bun's topics belong to one server, so
   * `ws.publish()` misses the WebSockets on the listener's other server after a `setTls()`.
   *
   * @returns The bytes sent, summed over the servers.
   */
  publish(
    topic: string,
    data: Parameters<Bun.Server<unknown>["publish"]>[1],
    compress?: boolean,
  ): number;
  /**
   * Replaces the handlers. Open connections and WebSockets stay; WebSocket limits don't change.
   *
   * @throws RackError `RACK_INVALID_CONFIG` for a handler that is not a function.
   */
  reload(handlers: ListenerHandlers<T>): void;
  /**
   * Replaces the certificates: a second server with the new ones takes over the address, and
   * the connections opened under the old ones keep working.
   *
   * @throws RackError `RACK_INVALID_CONFIG` when the certificates don't load; the old ones stay.
   */
  setTls(tls: ListenerTls | ListenerTls[]): Promise<void>;
}

/**
 * The smallest body that {@link wholeResponse} hands to Bun as a direct stream. For a smaller
 * one answered after an `await`, Bun 1.4.4 corks the socket and writes the response in one
 * piece; from this size on it writes the head uncorked, each piece a write of its own.
 *
 * @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#bodies-in-memory
 */
const DIRECT_FROM = 16 * 1024 - 1024;

/**
 * The `Content-Type` that Bun gives a body of bytes or of text, which a direct stream doesn't get.
 *
 * @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#bodies-in-memory
 */
const BYTES_TYPE = "application/octet-stream";
const TEXT_TYPE = "text/plain;charset=utf-8";

/**
 * Builds a `Response` whose body is in memory, in the form Bun sends fastest from a handler that
 * answers after an `await`, with the body's `Content-Length` at every size:
 *
 * - below 15 KiB, the body itself, which Bun writes in one piece with the head;
 * - from 15 KiB on, a direct stream whose high-water mark exceeds the body and that ends at once,
 *   which Bun also writes in one piece, with the length, where it would write the head of a body
 *   of bytes in pieces;
 * - for a `HEAD` request, the body itself, so that the answer has the `Content-Length` a `GET`
 *   would have.
 *
 * A response without a `Content-Type` gets the one Bun gives the same body, at every size:
 * `application/octet-stream` for bytes, and `text/plain;charset=utf-8` for text.
 *
 * @param request The request the response answers, for its method.
 * @param body The body: bytes, text, or `null` for none.
 * @param init The status and headers, as `new Response()` takes them.
 * @returns The response; `new Response(body, init)` works too, only slower from 15 KiB on.
 * @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#wholeresponse
 */
export function wholeResponse(
  request: Request,
  body: Uint8Array | ArrayBuffer | string | null,
  init?: ResponseInit,
): Response {
  if (body === null || request.method === "HEAD") return new Response(body, init);
  const text = typeof body === "string";
  const size = text ? Buffer.byteLength(body, "utf8") : body.byteLength;
  if (size < DIRECT_FROM) return new Response(body, init);
  const bytes = text
    ? new TextEncoder().encode(body)
    : body instanceof Uint8Array
      ? body
      : new Uint8Array(body);
  const stream = new ReadableStream(
    {
      type: "direct",
      pull(controller) {
        controller.write(bytes);
        const ended = controller.end();
        if (ended instanceof Promise) {
          ended.catch(() => {
            // The client left while the body was still going out; Bun ends the response.
          });
        }
      },
    },
    // Bun's sink holds writes below this mark, and sends a stream that ends before anything
    // went out with its length, in one write with its head.
    { highWaterMark: size + 1 },
  );
  // Bun's ResponseInit types its headers apart from the Headers constructor's.
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
  if (!headers.has("content-type")) headers.set("content-type", text ? TEXT_TYPE : BYTES_TYPE);
  return new Response(stream, { ...init, headers });
}

/** The absolute path of each response that {@link fileResponse} made, for `httpHandler`. */
const files = new WeakMap<Response, string>();

/**
 * Builds a `Response` whose body is a file, which Bun sends from disk as the client reads it,
 * with its `Content-Length` at every size, from a device's own listener or through the HTTP
 * panel: `httpHandler` sends such a response to the panel by its path, without reading the file,
 * and the panel answers with the file itself.
 *
 * Its `Content-Disposition` is `inline` unless `init` names one, so that a client doesn't see
 * the file's name on disk, which Bun would send.
 *
 * @param file The file: a path, which resolves against the working directory of the process as
 *   `Bun.file()` resolves it, or a file of `Bun.file()`.
 * @param init The status and headers, as `new Response()` takes them.
 * @returns The response. The file is opened only when the response goes out.
 * @throws RackError `RACK_INVALID_INPUT` for a file without a path, such as one of
 *   `Bun.file(fd)`.
 * @decision .agents/decisions/261119_205344-file-responses.md#fileresponse
 */
export function fileResponse(file: string | Bun.BunFile, init?: ResponseInit): Response {
  const name = typeof file === "string" ? file : file.name;
  if (typeof name !== "string" || name === "") {
    throw new RackError("RACK_INVALID_INPUT", "fileResponse needs a file with a path");
  }
  const path = resolve(name);
  // Bun's ResponseInit types its headers apart from the Headers constructor's.
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
  if (!headers.has("content-disposition")) headers.set("content-disposition", "inline");
  const response = new Response(typeof file === "string" ? Bun.file(path) : file, {
    ...init,
    headers,
  });
  files.set(response, path);
  return response;
}

/**
 * The absolute path of a response that {@link fileResponse} made.
 *
 * @returns The path, or `undefined` for any other response.
 */
export function fileOf(response: Response): string | undefined {
  return files.get(response);
}

/** A pair as it goes to Bun: PEM text. */
interface Pair {
  cert: string;
  key: string;
  serverName?: string;
  passphrase?: string;
}

interface Limits {
  maxRequestBodySize: number;
  idleTimeout: number;
  wsPayload: number;
  wsIdle: number;
  wsBuffered: number;
}

/** A WebSocket of a listener, and the calls of its message handler that haven't returned. */
interface Socket {
  readonly server: Bun.Server<unknown>;
  inFlight: number;
}

/** A request waiting for the install: resolved with `true` to go on, `false` to get 503. */
type Held = (go: boolean) => void;

interface State {
  readonly index: number;
  readonly hostname: string;
  readonly declared: number;
  readonly ordinal: number;
  readonly port: number;
  readonly url: URL;
  readonly limits: Limits;
  readonly allowed: ReadonlySet<string> | undefined;
  /** The last `Host` header that passed the check; most requests repeat it. */
  lastHost: string | undefined;
  handlers: Normalized;
  pairs: Pair[] | undefined;
  certificates: CertificateInfo[];
  /** The server that listens, if any, first; then the ones that still serve older connections. */
  servers: Bun.Server<unknown>[];
  listening: boolean;
  /** The close code of the WebSockets once the instance has left service; `undefined` before. */
  closing: number | undefined;
  readonly sockets: Map<Bun.ServerWebSocket<unknown>, Socket>;
  readonly held: Held[];
  listener: Listener;
}

/** Handlers after checking, with routes wrapped once per listener. */
interface Normalized {
  fetch: ListenerHandler | undefined;
  routes: Record<string, ListenerRoute> | undefined;
  error: ((error: Error) => Response | Promise<Response>) | undefined;
  websocket: ListenerWebSocket | undefined;
}

/** What the Worker host gives the listeners of its instance. */
export interface ListenerHostOptions {
  /** The device's name, for messages. */
  name: () => string;
  /** The most requests that may wait for the install, per listener: the rack's `queueLimit`. */
  queueLimit: () => number;
  /** Asks the rack's main thread; rejects with the `RackError` it answers with. */
  ask: (ask: ReserveAsk) => Promise<unknown>;
  /** Tells the main thread what the listeners are now. */
  report: (listeners: ListenerReport[]) => void;
  log: (level: LogLevel, message: string, data?: unknown) => void;
  /** Writes a listener's counters into the memory the main thread reads for `status()`. */
  count: (index: number, requests: number, webSockets: number) => void;
  /** Called when requests or messages finish, so that drains can resolve. */
  wake: () => void;
}

function invalid(message: string, data?: unknown): RackError {
  return new RackError("RACK_INVALID_CONFIG", message, data);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function isLoopback(hostname: string): boolean {
  return (
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === "::1" ||
    hostname === "localhost"
  );
}

/** The host name of a `Host` header, without its port, in lower case. */
function hostOf(header: string | null): string | undefined {
  if (header === null) return undefined;
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end < 0 ? undefined : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  return colon < 0 ? value : value.slice(0, colon);
}

async function pem(value: unknown, what: string): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof Blob) return await value.text();
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw invalid(`${what} must be PEM text, bytes, or a file`);
}

/**
 * Reads the pairs of a `tls` option into PEM text.
 *
 * @throws RackError `RACK_INVALID_CONFIG` for a malformed option.
 */
export async function readPairs(tls: unknown): Promise<Pair[]> {
  const list = Array.isArray(tls) ? tls : [tls];
  if (list.length === 0) throw invalid("tls must name at least one certificate");
  const pairs: Pair[] = [];
  for (const [index, entry] of list.entries()) {
    const where = Array.isArray(tls) ? `tls[${index}]` : "tls";
    if (typeof entry !== "object" || entry === null) {
      throw invalid(`${where} must be { cert, key }`);
    }
    const { cert, key, serverName, passphrase } = entry as Record<string, unknown>;
    const pair: Pair = {
      cert: await pem(cert, `${where}.cert`),
      key: await pem(key, `${where}.key`),
    };
    if (serverName !== undefined) {
      if (typeof serverName !== "string" || serverName === "") {
        throw invalid(`${where}.serverName must be a non-empty string`);
      }
      pair.serverName = serverName;
    } else if (Array.isArray(tls) && tls.length > 1) {
      throw invalid(`${where}.serverName is required in a list of certificates`);
    }
    if (passphrase !== undefined) {
      if (typeof passphrase !== "string") throw invalid(`${where}.passphrase must be a string`);
      pair.passphrase = passphrase;
    }
    pairs.push(pair);
  }
  return pairs;
}

/** The `tls` option of `Bun.serve` for the pairs. */
function bunTls(pairs: Pair[]): Bun.TLSOptions | Bun.TLSOptions[] {
  return pairs.length === 1 && pairs[0]?.serverName === undefined ? (pairs[0] as Pair) : pairs;
}

/**
 * What `status()` shows of each certificate: its subject, its server name, and its expiry.
 * A certificate that can't be parsed shows its subject as unknown.
 */
export function describePairs(pairs: Pair[] | undefined): CertificateInfo[] {
  return (pairs ?? []).map((pair) => {
    let subject = "unknown";
    let notAfter = 0;
    try {
      const x509 = new X509Certificate(pair.cert);
      subject = x509.subject;
      notAfter = Date.parse(x509.validTo);
    } catch {
      // Bun already accepted the pair; a certificate that node:crypto can't parse still serves.
    }
    const info: CertificateInfo = { subject, notAfter };
    if (pair.serverName !== undefined) info.serverName = pair.serverName;
    return info;
  });
}

/**
 * Checks that the pairs load, by binding a server with them for a moment: Bun checks
 * certificates only when a server binds.
 *
 * @throws RackError `RACK_INVALID_CONFIG` with Bun's error when they don't load.
 */
export async function checkPairs(pairs: Pair[]): Promise<void> {
  let server: Bun.Server<unknown>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: bunTls(pairs),
      fetch: () => new Response(null, { status: 503 }),
    });
  } catch (error) {
    throw invalid(`the certificates don't load: ${toWireError(error).message}`);
  }
  await server.stop(true);
}

function checkHandlers(handlers: ListenerHandlers, where: string): Normalized {
  const { fetch, routes, error, websocket } = handlers;
  if (fetch !== undefined && !isFunction(fetch))
    throw invalid(`${where}: fetch must be a function`);
  if (error !== undefined && !isFunction(error))
    throw invalid(`${where}: error must be a function`);
  if (routes !== undefined) {
    if (typeof routes !== "object" || routes === null) {
      throw invalid(`${where}: routes must be an object`);
    }
    for (const [path, route] of Object.entries(routes)) {
      if (route instanceof Response || isFunction(route)) continue;
      if (typeof route === "object" && route !== null) {
        for (const [method, value] of Object.entries(route)) {
          if (!(value instanceof Response || isFunction(value))) {
            throw invalid(`${where}: routes["${path}"].${method} must be a handler or a Response`);
          }
        }
        continue;
      }
      throw invalid(`${where}: routes["${path}"] must be a handler, a Response, or one per method`);
    }
  }
  if (websocket !== undefined) {
    if (typeof websocket !== "object" || websocket === null) {
      throw invalid(`${where}: websocket must be an object`);
    }
    for (const name of ["open", "message", "close", "drain", "ping", "pong"] as const) {
      if (websocket[name] !== undefined && !isFunction(websocket[name])) {
        throw invalid(`${where}: websocket.${name} must be a function`);
      }
    }
  }
  return { fetch, routes, error, websocket };
}

function positive(value: unknown, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(`${what} must be a positive number`);
  }
  return value;
}

function seconds(
  value: unknown,
  fallback: number,
  low: number,
  high: number,
  what: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < low || (value as number) > high) {
    throw invalid(`${what} must be a whole number of seconds from ${low} to ${high}`);
  }
  return value as number;
}

/**
 * Binds a port without `reusePort` and closes it at once: a check that no other process holds
 * the address, which also picks the port for port 0.
 *
 * @returns The port.
 * @throws RackError `RACK_HOOK_FAILED` with the system's code in `data.cause`.
 */
async function checkBind(hostname: string, port: number, listener: string): Promise<number> {
  let server: Bun.Server<unknown>;
  try {
    server = Bun.serve({ hostname, port, fetch: () => new Response(null, { status: 503 }) });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const cause = typeof code === "string" ? code : "EADDRNOTAVAIL";
    const holder = cause === "EADDRINUSE" ? { holder: "another process" } : {};
    throw new RackError(
      "RACK_HOOK_FAILED",
      `ctx.serve: ${listener} can't be reserved: ${toWireError(error).message}`,
      { listener, cause, ...holder },
    );
  }
  const actual = server.port as number;
  await server.stop(true);
  return actual;
}

/** The listeners of one instance. */
export class ListenerHost {
  readonly #options: ListenerHostOptions;
  readonly #states: State[] = [];
  #inherited: InheritedListener[] = [];
  /** The `serve()` calls of the `powerOn` that runs; unset outside `powerOn`. */
  #declaring: Promise<unknown>[] | undefined;
  #installed = false;
  /** Request handlers and WebSocket message handlers that haven't returned. */
  #handling = 0;
  /** The server that took each request, for the methods of the listener. */
  readonly #taken = new WeakMap<Request, Bun.Server<unknown>>();
  #ticker: ReturnType<typeof setInterval> | undefined;
  /** The promise that the handlers of this turn of the event loop wait for, if any. */
  #outsideTurn: Promise<void> | undefined;

  constructor(options: ListenerHostOptions) {
    this.#options = options;
  }

  /** Request handlers and WebSocket message handlers that haven't returned; drains wait for them. */
  get handling(): number {
    return this.#handling;
  }

  /**
   * Requests whose responses haven't finished, as Bun counts them, streamed bodies included;
   * the drain of a retirement waits for them.
   */
  get pending(): number {
    let count = 0;
    for (const state of this.#states) {
      for (const server of state.servers) count += server.pendingRequests;
    }
    return count;
  }

  /** `powerOn` starts: `serve()` may be called, and `inherited` gives the device's earlier ports. */
  begin(inherited: InheritedListener[]): void {
    this.#inherited = inherited;
    this.#declaring = [];
  }

  /**
   * `powerOn` returned: waits for the `serve()` calls it made.
   *
   * @throws The error of a `serve()` that rejected, even one the device caught.
   */
  async end(): Promise<void> {
    const declaring = this.#declaring ?? [];
    this.#declaring = undefined;
    const settled = await Promise.allSettled(declaring);
    for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
  }

  /** `ctx.serve`; see {@link ServeOptions}. */
  serve(options: ServeOptions): Promise<Listener> {
    const declaring = this.#declaring;
    if (declaring === undefined) {
      return Promise.reject(
        new RackError(
          "RACK_HOOK_FAILED",
          `${this.#options.name()}: ctx.serve can be called in powerOn only`,
        ),
      );
    }
    const promise = this.#declare(options);
    declaring.push(promise);
    return promise;
  }

  async #declare(options: ServeOptions): Promise<Listener> {
    const name = this.#options.name();
    if (typeof options !== "object" || options === null) {
      throw new RackError("RACK_HOOK_FAILED", `${name}: ctx.serve requires an options object`);
    }
    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    const declared = options.port;
    const listener = `${hostname}:${String(declared)}`;
    const fail = (error: unknown): RackError => {
      const failure = error instanceof RackError ? error : fromWireError(toWireError(error));
      if (failure.code === "RACK_HOOK_FAILED") return failure;
      return new RackError("RACK_HOOK_FAILED", `${name}: ctx.serve: ${failure.message}`, {
        listener,
      });
    };
    let state: State;
    try {
      if (typeof hostname !== "string" || hostname === "")
        throw invalid("hostname must be a non-empty string");
      if (!Number.isInteger(declared) || declared < 0 || declared > 65_535) {
        throw invalid("port must be a whole number from 0 to 65 535");
      }
      if (this.#states.length >= LISTENER_LIMIT) {
        throw invalid(`an instance has at most ${LISTENER_LIMIT} listeners`);
      }
      const handlers = checkHandlers(options, "ctx.serve");
      const ws = options.websocket ?? {};
      const limits: Limits = {
        maxRequestBodySize: positive(
          options.maxRequestBodySize,
          DEFAULT_BODY,
          "maxRequestBodySize",
        ),
        idleTimeout: seconds(options.idleTimeout, DEFAULT_IDLE, 1, 255, "idleTimeout"),
        wsPayload: positive(ws.maxPayloadLength, DEFAULT_WS_PAYLOAD, "websocket.maxPayloadLength"),
        wsIdle: seconds(ws.idleTimeout, DEFAULT_WS_IDLE, 8, 960, "websocket.idleTimeout"),
        wsBuffered: positive(ws.maxBuffered, DEFAULT_WS_BUFFERED, "websocket.maxBuffered"),
      };
      let allowed: Set<string> | undefined;
      if (isLoopback(hostname)) {
        const extra = options.allowedHosts ?? [];
        if (
          !Array.isArray(extra) ||
          extra.some((host) => typeof host !== "string" || host === "")
        ) {
          throw invalid("allowedHosts must be a list of host names");
        }
        allowed = new Set([
          hostname.toLowerCase(),
          "localhost",
          ...extra.map((h) => h.toLowerCase()),
        ]);
      } else if (options.allowedHosts !== undefined && !Array.isArray(options.allowedHosts)) {
        throw invalid("allowedHosts must be a list of host names");
      }
      // Bun checks certificates only when a server binds, after activate; this checks them now.
      const pairs = options.tls === undefined ? undefined : await readPairs(options.tls);
      if (pairs !== undefined) await checkPairs(pairs);
      const ordinal = this.#states.filter(
        (s) => s.hostname === hostname && s.declared === declared,
      ).length;
      const inherited = this.#inherited.find(
        (i) => i.hostname === hostname && i.declared === declared && i.ordinal === ordinal,
      );
      let port = inherited?.port ?? declared;
      const reserve = () =>
        this.#options.ask({ kind: "reserve", hostname, declared, ordinal, port });
      // A port the rack knows is reserved first, so that a device that holds it is named.
      if (port !== 0) await reserve();
      // An instance of the device that holds the port listens with reusePort; any other holder
      // makes a bind without it fail.
      if (inherited?.held !== true) port = await checkBind(hostname, port, listener);
      if (declared === 0 && inherited === undefined) await reserve();
      const protocol = pairs === undefined ? "http" : "https";
      const host = hostname.includes(":") ? `[${hostname}]` : hostname;
      state = {
        index: this.#states.length,
        hostname,
        declared,
        ordinal,
        port,
        url: new URL(`${protocol}://${host}:${port}/`),
        limits,
        allowed,
        lastHost: undefined,
        handlers,
        pairs,
        certificates: describePairs(pairs),
        servers: [],
        listening: false,
        closing: undefined,
        sockets: new Map(),
        held: [],
        listener: undefined as unknown as Listener,
      };
    } catch (error) {
      throw fail(error);
    }
    state.listener = this.#facade(state);
    this.#states.push(state);
    this.#report();
    return state.listener;
  }

  /**
   * The rack puts the instance into service: every listener that doesn't listen binds, with
   * `reusePort`, and its paused WebSockets read again.
   *
   * @returns The URLs of the listeners that bound.
   * @throws RackError `RACK_HOOK_FAILED` when a bind fails; listeners bound before it stay.
   */
  listen(): string[] {
    const bound: string[] = [];
    for (const state of this.#states) {
      if (state.listening) continue;
      let server: Bun.Server<unknown>;
      try {
        server = this.#bind(state, state.pairs);
      } catch (error) {
        const listener = `${state.hostname}:${state.port}`;
        throw new RackError(
          "RACK_HOOK_FAILED",
          `${this.#options.name()}: ${listener} did not bind: ${toWireError(error).message}`,
          { listener, cause: toWireError(error).message },
        );
      }
      state.servers.unshift(server);
      state.listening = true;
      state.closing = undefined;
      for (const ws of state.sockets.keys()) ws.resume();
      bound.push(state.url.href);
    }
    if (bound.length > 0) this.#startTicker();
    this.#report();
    return bound;
  }

  /**
   * The instance leaves service: its servers stop listening, requests waiting for the install
   * get 503, and its WebSockets stop reading and close with `code` once their messages in
   * flight have been handled.
   *
   * @returns The URLs of the listeners that stopped.
   */
  unlisten(code: number): string[] {
    const stopped: string[] = [];
    for (const state of this.#states) {
      for (const held of state.held.splice(0)) held(false);
      if (!state.listening) continue;
      state.listening = false;
      state.closing = code;
      // A graceful stop: requests in flight and WebSockets go on; the promise is the connections'.
      for (const server of state.servers) void server.stop();
      for (const [ws, socket] of state.sockets) {
        ws.pause();
        if (socket.inFlight === 0) ws.close(code, reason(code));
      }
      stopped.push(state.url.href);
    }
    this.#report();
    this.#count();
    return stopped;
  }

  /** Whether the instance is installed; requests wait for it, and go on in order once it is. */
  setInstalled(installed: boolean): void {
    this.#installed = installed;
    if (!installed) return;
    for (const state of this.#states) for (const held of state.held.splice(0)) held(true);
  }

  /** The listeners as `status()` shows them, without their counters. */
  reports(): ListenerReport[] {
    return this.#states.map((state) => ({
      index: state.index,
      url: state.url.href,
      listening: state.listening,
      certificates: state.certificates,
    }));
  }

  #report(): void {
    this.#options.report(this.reports());
  }

  /** Copies Bun's counters of each listener into the memory the main thread reads. */
  #count(): void {
    for (const state of this.#states) {
      let requests = 0;
      let webSockets = 0;
      for (const server of state.servers) {
        requests += server.pendingRequests;
        webSockets += server.pendingWebSockets;
      }
      this.#options.count(state.index, requests, webSockets);
    }
  }

  #startTicker(): void {
    if (this.#ticker !== undefined) return;
    // A streamed response ends without an event the host sees, so the counters, and the drains
    // that wait for them, catch up on a timer.
    this.#ticker = setInterval(() => {
      this.#count();
      this.#options.wake();
    }, TICK_MS);
  }

  #bind(state: State, pairs: Pair[] | undefined): Bun.Server<unknown> {
    let server: Bun.Server<unknown> | undefined;
    const taken = () => server as Bun.Server<unknown>;
    const options = {
      hostname: state.hostname,
      port: state.port,
      reusePort: true,
      maxRequestBodySize: state.limits.maxRequestBodySize,
      idleTimeout: state.limits.idleTimeout,
      ...(pairs === undefined ? {} : { tls: bunTls(pairs) }),
      ...this.#handlersFor(state, taken),
      websocket: this.#websocket(state, taken),
    };
    // The options mix fetch, routes, and websocket in ways Bun's overloads type one by one.
    server = Bun.serve(options as unknown as Bun.Serve.Options<unknown, string>);
    return server;
  }

  /** The `fetch`, `routes`, and `error` of one server, which `reload()` replaces too. */
  #handlersFor(state: State, taken: () => Bun.Server<unknown>): Record<string, unknown> {
    const routes = state.handlers.routes;
    return {
      fetch: (request: Request) => this.#handle(state, taken(), request, state.handlers.fetch),
      ...(routes === undefined ? {} : { routes: this.#routes(state, taken, routes) }),
      error: (error: Error) => {
        const handler = state.handlers.error;
        if (handler !== undefined) return handler(error);
        this.#options.log("error", "a request handler failed", {
          url: state.url.href,
          error: toWireError(error),
        });
        return new Response("Internal Server Error", { status: 500 });
      },
    };
  }

  #routes(
    state: State,
    taken: () => Bun.Server<unknown>,
    routes: Record<string, ListenerRoute>,
  ): Record<string, unknown> {
    const wrap = (route: ListenerRouteHandler | Response) => {
      const handler: ListenerHandler =
        route instanceof Response
          ? () => route.clone() as Response
          : (request, listener) => route(request as Bun.BunRequest<string>, listener);
      return (request: Request) => this.#handle(state, taken(), request, handler);
    };
    const wrapped: Record<string, unknown> = {};
    for (const [path, route] of Object.entries(routes)) {
      if (route instanceof Response || isFunction(route)) {
        wrapped[path] = wrap(route as ListenerRouteHandler | Response);
        continue;
      }
      const methods: Record<string, unknown> = {};
      for (const [method, value] of Object.entries(route)) {
        if (value !== undefined) methods[method] = wrap(value);
      }
      wrapped[path] = methods;
    }
    return wrapped;
  }

  async #handle(
    state: State,
    server: Bun.Server<unknown>,
    request: Request,
    handler: ListenerHandler | undefined,
  ): Promise<Response | undefined> {
    this.#taken.set(request, server);
    // A page whose own domain resolves to 127.0.0.1 would reach a loopback listener as the same
    // origin; only the Host header gives it away.
    // @decision .agents/decisions/261118_070617-panels-as-devices.md#defaults-and-bounds
    if (state.allowed !== undefined) {
      const raw = request.headers.get("host") ?? undefined;
      if (raw === undefined || raw !== state.lastHost) {
        const host = hostOf(raw ?? null);
        if (host === undefined || !state.allowed.has(host)) {
          return new Response("Forbidden: unknown host", { status: 403 });
        }
        state.lastHost = raw;
      }
    }
    if (!this.#installed) {
      if (state.held.length >= this.#options.queueLimit()) {
        return new Response("Service Unavailable", { status: 503 });
      }
      // Bun's timer would cut a request that waits through a long state handover; the wait ends
      // with the swap instead.
      server.timeout(request, 0);
      const go = await new Promise<boolean>((resolve) => state.held.push(resolve));
      server.timeout(request, state.limits.idleTimeout);
      if (!go) return new Response("Service Unavailable", { status: 503 });
    }
    // A handler that is still running when the Worker ends gets Bun's placeholder answer, a 200
    // "Welcome to Bun!", instead of a failure. Run outside Bun's callback, the request fails.
    await this.#outside();
    // The counters that status() shows catch up on the ticker, not per request, which saves a
    // copy of every listener's counters twice per request.
    this.#handling++;
    try {
      if (handler === undefined) return new Response("Not Found", { status: 404 });
      return await handler(request, state.listener);
    } finally {
      this.#handling--;
      this.#options.wake();
    }
  }

  /**
   * Resolves after a `setImmediate`, outside Bun's callback. The handlers that arrive in one turn
   * of the event loop share one `setImmediate` and one promise, which they would otherwise each
   * create.
   */
  #outside(): Promise<void> {
    this.#outsideTurn ??= new Promise<void>((resolve) => {
      setImmediate(() => {
        this.#outsideTurn = undefined;
        resolve();
      });
    });
    return this.#outsideTurn;
  }

  #websocket(state: State, taken: () => Bun.Server<unknown>): Record<string, unknown> {
    const handlers = () => state.handlers.websocket;
    const { wsPayload, wsIdle, wsBuffered } = state.limits;
    return {
      maxPayloadLength: wsPayload,
      idleTimeout: wsIdle,
      sendPings: true,
      // Bun drops a message past backpressureLimit; the rack closes a WebSocket at maxBuffered,
      // before that.
      backpressureLimit: wsBuffered + wsPayload,
      closeOnBackpressureLimit: false,
      open: (ws: Bun.ServerWebSocket<unknown>) => {
        state.sockets.set(ws, { server: taken(), inFlight: 0 });
        guardSends(ws, wsBuffered);
        this.#count();
        return handlers()?.open?.(ws);
      },
      message: async (ws: Bun.ServerWebSocket<unknown>, message: string | Buffer<ArrayBuffer>) => {
        const socket = state.sockets.get(ws);
        if (socket !== undefined) socket.inFlight++;
        this.#handling++;
        try {
          await handlers()?.message?.(ws, message);
        } finally {
          this.#handling--;
          if (socket !== undefined) {
            socket.inFlight--;
            if (state.closing !== undefined && socket.inFlight === 0) {
              ws.close(state.closing, reason(state.closing));
            }
          }
          this.#options.wake();
        }
      },
      close: (ws: Bun.ServerWebSocket<unknown>, code: number, why: string) => {
        state.sockets.delete(ws);
        this.#count();
        return handlers()?.close?.(ws, code, why);
      },
      drain: (ws: Bun.ServerWebSocket<unknown>) => handlers()?.drain?.(ws),
      ping: (ws: Bun.ServerWebSocket<unknown>, data: Buffer) => handlers()?.ping?.(ws, data),
      pong: (ws: Bun.ServerWebSocket<unknown>, data: Buffer) => handlers()?.pong?.(ws, data),
    };
  }

  #facade(state: State): Listener {
    const server = (request: Request): Bun.Server<unknown> => {
      const taken = this.#taken.get(request) ?? state.servers[0];
      if (taken === undefined) {
        throw new RackError(
          "RACK_INVALID_INPUT",
          `${state.url.href}: the request is not one of the listener's`,
        );
      }
      return taken;
    };
    const facade: Listener = {
      url: state.url,
      hostname: state.hostname,
      port: state.port,
      upgrade: (request, options) =>
        (server(request).upgrade as (request: Request, options?: unknown) => boolean)(
          request,
          options,
        ),
      timeout: (request, seconds) => server(request).timeout(request, seconds),
      requestIP: (request) => server(request).requestIP(request),
      publish: (topic, data, compress) => {
        let sent = 0;
        for (const each of state.servers) sent += each.publish(topic, data, compress);
        return sent;
      },
      reload: (handlers) => {
        const next = checkHandlers(handlers, `${state.url.href} reload`);
        const routesChanged = handlers.routes !== undefined;
        state.handlers = {
          fetch: handlers.fetch ?? state.handlers.fetch,
          routes: next.routes ?? state.handlers.routes,
          error: handlers.error ?? state.handlers.error,
          websocket: handlers.websocket ?? state.handlers.websocket,
        };
        if (!routesChanged) return;
        for (const each of state.servers) {
          each.reload(
            this.#handlersFor(state, () => each) as unknown as Bun.Serve.Options<unknown, string>,
          );
        }
      },
      setTls: (tls) => this.#setTls(state, tls),
    };
    return Object.freeze(facade);
  }

  /**
   * Replaces a listener's certificates with a handover to a second server. The listener keeps
   * at most two servers: a further `setTls()` closes the older one first.
   */
  async #setTls(state: State, tls: ListenerTls | ListenerTls[]): Promise<void> {
    const where = state.url.href;
    let pairs: Pair[];
    try {
      pairs = await readPairs(tls);
      if (!state.listening) {
        // Not bound yet: the pairs take effect when it binds.
        await checkPairs(pairs);
        state.pairs = pairs;
        state.certificates = describePairs(pairs);
        this.#report();
        return;
      }
      const [current, ...older] = state.servers;
      for (const server of older) this.#closeServer(state, server);
      const next = this.#bind(state, pairs);
      state.servers = [next, ...(current === undefined ? [] : [current])];
      if (current !== undefined) void current.stop();
    } catch (error) {
      const failure =
        error instanceof RackError
          ? error
          : invalid(`the certificates don't load: ${toWireError(error).message}`);
      this.#options.log("error", "certificates rejected", {
        url: where,
        error: toWireError(failure),
      });
      throw failure.code === "RACK_INVALID_CONFIG" ? failure : invalid(failure.message);
    }
    state.pairs = pairs;
    state.certificates = describePairs(pairs);
    this.#options.log("info", "certificates replaced", {
      url: where,
      certificates: state.certificates,
    });
    this.#report();
  }

  /** Closes a server that only serves older connections: its WebSockets with 1012, the rest at once. */
  #closeServer(state: State, server: Bun.Server<unknown>): void {
    for (const [ws, socket] of state.sockets) {
      if (socket.server === server) ws.close(1012, reason(1012));
    }
    void server.stop(true);
    state.servers = state.servers.filter((each) => each !== server);
  }
}

/** The reason that goes with a close code the rack sends. */
function reason(code: number): string {
  if (code === 1012) return "service restart";
  if (code === 1001) return "going away";
  if (code === 1013) return "try again later";
  return "";
}

/**
 * Makes a WebSocket close with 1013 instead of growing: when the device sends to it while more
 * than `limit` bytes are unsent, or when Bun drops a message.
 */
function guardSends(ws: Bun.ServerWebSocket<unknown>, limit: number): void {
  const guard =
    <A extends unknown[]>(send: (...args: A) => number) =>
    (...args: A): number => {
      if (ws.getBufferedAmount() > limit) {
        ws.close(1013, reason(1013));
        return 0;
      }
      const status = send.apply(ws, args);
      if (status === 0) ws.close(1013, reason(1013));
      return status;
    };
  // ServerWebSocket instances take own properties, which shadow the methods of their prototype.
  const target = ws as unknown as Record<string, unknown>;
  target.send = guard(ws.send);
  target.sendText = guard(ws.sendText);
  target.sendBinary = guard(ws.sendBinary);
}

/** Revives the error that the main thread answered an ask with. */
export function askError(error: WireError): RackError {
  return fromWireError(error);
}
