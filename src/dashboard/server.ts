/**
 * `rack dashboard`: a server on loopback that serves the dashboard's page, and forwards what the
 * page asks for to the management endpoint of a running rack, which it finds again for each
 * request, as `rack ctl` finds it. It keeps none of the rack's data between requests, and the
 * rack's process opens nothing new for it.
 *
 * Its API isn't public: programs use the management endpoint, as `rack ctl` does.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#rack-dashboard
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-the-dashboard-forwards
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#how-the-page-is-built
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  describeError,
  fail,
  findEndpoint,
  postOperation,
  type RackTarget,
  rackTarget,
} from "../commands.ts";
import { oneLine } from "../log.ts";
import page from "./page/index.html";

/** How many requests may wait for the rack at once: 16. One more gets 503. */
export const WAITING_LIMIT = 16;

/** The largest body of a request, in bytes: 64 KiB. A larger one gets 413. */
export const BODY_LIMIT = 64 * 1024;

/**
 * How long a read waits for the rack's answer, in ms: 60 s, more than the default `hookTimeout`
 * of 30 s for which `metrics()` waits for a device. Then 504.
 */
export const READ_TIMEOUT_MS = 60_000;

/** How long an operation waits for the rack's answer, in ms: 10 minutes. Then 504. */
export const OPERATION_TIMEOUT_MS = 10 * 60_000;

/** The bounds of a dashboard, which {@link DashboardOptions.bounds} shortens for tests. */
export interface DashboardBounds {
  /** {@link WAITING_LIMIT} */
  waiting: number;
  /** {@link BODY_LIMIT} */
  body: number;
  /** {@link READ_TIMEOUT_MS} */
  read: number;
  /** {@link OPERATION_TIMEOUT_MS} */
  operation: number;
}

/** What {@link openDashboard} serves. */
export interface DashboardOptions {
  /** The rack: the one whose base directory is a path, or the one whose TCP endpoint is a URL. */
  target: RackTarget;
  /** The port to listen on, on `127.0.0.1`; 0 for a free one. */
  port: number;
  /**
   * Receives each line that the dashboard prints, without its newline, with its control
   * characters escaped; by default `console.log`.
   */
  print?: (line: string) => void;
  /**
   * Shorter bounds, for tests, in place of the constants. racku's entry points don't export this
   * module, so programs can't change them.
   *
   * @internal
   */
  bounds?: Partial<DashboardBounds>;
}

/** A running dashboard. */
export interface Dashboard {
  /**
   * The page's URL, `http://127.0.0.1:<port>/#token=<token>`, which carries the token in its
   * fragment: whoever holds it can operate the rack.
   */
  readonly url: string;
  /** The port it listens on. */
  readonly port: number;
  /** Stops listening, and ends the connections still open. */
  stop(): Promise<void>;
}

/**
 * The most characters of a rollback's `to`: 128, far more than the hash of any firmware. The rack
 * keeps the `to` of a rollback that fails in a record of its history.
 */
const FIRMWARE_MAX = 128;

/** What an option of a forwarded operation is. */
type Option =
  /** `true` or `false`, as restart's `cascade`. */
  | "boolean"
  /** A firmware's hash, as rollback's `to`: a string of {@link FIRMWARE_MAX} characters at most. */
  | "firmware";

/** What each kind of option is, for the message of a 400. */
const OPTION_TEXT: Readonly<Record<Option, string>> = {
  boolean: "true or false",
  firmware: `a firmware's hash of ${FIRMWARE_MAX} characters at most`,
};

/** What an argument of a forwarded operation is. */
type Argument =
  /** A device's name. */
  | "name"
  /**
   * An object that may hold these options, each of its kind, and no others, such as
   * `{ cascade: false }` or `{ to }`.
   */
  | Readonly<Record<string, Option>>
  /** A value that the rack checks itself, as `events()` checks `after`. */
  | "value";

/** An operation that the dashboard forwards: whether it reads or operates, and its arguments. */
interface Forwarded {
  kind: "read" | "operation";
  /** How many arguments it needs at least. */
  min: number;
  /** What each argument it takes is; their number is the most it takes. */
  args: readonly Argument[];
}

/**
 * The operations that the dashboard forwards, with the arguments that the endpoint takes, apart
 * from `swap`, which takes the device's name only: a swap to another device file, `plug`, and
 * `unplug` stay with `rack ctl` and code, so that a dashboard's URL can't make the rack run a file
 * that it doesn't run already. The options of `restart` and `rollback` are the ones that the page
 * sends.
 */
const FORWARDED: Readonly<Record<string, Forwarded>> = {
  status: { kind: "read", min: 0, args: [] },
  metrics: { kind: "read", min: 0, args: [] },
  history: { kind: "read", min: 0, args: ["name"] },
  events: { kind: "read", min: 0, args: ["value"] },
  reload: { kind: "operation", min: 0, args: [] },
  swap: { kind: "operation", min: 1, args: ["name"] },
  restart: { kind: "operation", min: 1, args: ["name", { cascade: "boolean" }] },
  rollback: { kind: "operation", min: 1, args: ["name", { to: "firmware" }] },
  stop: { kind: "operation", min: 0, args: [] },
};

/** The dashboard's own operation, which says what it watches. */
const ABOUT: Forwarded = { kind: "read", min: 0, args: [] };

/** A `Host` that names loopback, `127.0.0.1`, `localhost`, or `[::1]`, with any port. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/** Every answer of the API: no cache keeps one, and no CORS header lets another site read it. */
const NO_STORE = { "cache-control": "no-store" };

/**
 * The answer to an operation, whose wait turned the connection's idle timeout off: the
 * connection closes after it, so that it doesn't stay open without one.
 */
const CLOSE = { connection: "close" };

/**
 * Opens a dashboard: serves the page at `/`, and its API under `/api/v1/`.
 *
 * @returns The running dashboard, whose URL holds a new token of 256 random bits.
 * @throws Error when the server can't listen, such as on a port that is taken.
 */
export function openDashboard(options: DashboardOptions): Dashboard {
  const bounds: DashboardBounds = {
    waiting: WAITING_LIMIT,
    body: BODY_LIMIT,
    read: READ_TIMEOUT_MS,
    operation: OPERATION_TIMEOUT_MS,
    ...options.bounds,
  };
  const print = (line: string) => (options.print ?? console.log)(oneLine(line));
  const target = options.target;
  const watched = "url" in target ? target.url : target.dir;
  const token = randomBytes(32).toString("base64url");
  const wanted = Buffer.from(token);
  let waiting = 0;
  /** Whether the rack answered the last `status` that the dashboard forwarded. */
  let answering: boolean | undefined;

  // Only `Bearer <token>`, compared in constant time; a bare token, or none, gets 401.
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
  const authorized = (header: string | null): boolean => {
    const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  /**
   * Prints a line when the rack stops answering, and when it answers again, as its answers to
   * `status` tell: the rack answers status at once, and the page tells its connection by it too.
   * A read of another kind may fail on its own, as `events` does on a rack of racku 1.0.0, which
   * the page shows; and each operation prints a line of its own.
   *
   * @decision .agents/decisions/261124_055114-rack-dashboard.md#rack-dashboard
   */
  const answered = (answer: Answer) => {
    if ("text" in answer) {
      if (answering === false) print("the rack answers");
      answering = true;
    } else {
      if (answering !== false) print(`the rack doesn't answer: ${answer.message}`);
      answering = false;
    }
  };

  const forward = async (
    request: Request,
    server: Bun.Server<undefined>,
    op: string,
    spec: Forwarded,
    args: unknown[],
  ): Promise<Response> => {
    const limit = spec.kind === "read" ? bounds.read : bounds.operation;
    // Bun may end a connection whose request waits past its idle timeout, 10 s by default, while
    // the wait below has bounds of its own. A read's connection gets a timeout past its bound; an
    // operation's, which may wait 10 minutes, gets none, and closes after its answer.
    server.timeout(request, spec.kind === "read" ? Math.ceil(limit / 1000) + 10 : 0);
    const close = spec.kind === "operation" ? CLOSE : {};
    waiting++;
    let answer: Answer;
    try {
      answer = await ask(target, op, args, limit, spec.kind);
    } finally {
      waiting--;
    }
    if (op === "status") answered(answer);
    if (spec.kind === "operation") {
      print(
        `${[op, ...args.map(word)].join(" ")}: ${"text" in answer ? answer.outcome : answer.message}`,
      );
    }
    if (!("text" in answer)) return problem(answer.status, answer.message, close);
    // The rack's answer as it came, whether the operation succeeded or failed.
    return new Response(answer.text, {
      headers: { "content-type": "application/json", ...NO_STORE, ...close },
    });
  };

  const serve = async (request: Request, server: Bun.Server<undefined>): Promise<Response> => {
    const { pathname } = new URL(request.url);
    // Only the page is served outside the API: Bun answers "/" and the page's files itself.
    if (!pathname.startsWith("/api/")) return new Response(null, { status: 404 });
    if (!fromTheDashboard(request.headers)) return empty(403);
    if (!authorized(request.headers.get("authorization"))) return empty(401);
    if (request.method !== "POST") {
      return problem(405, "the dashboard's API takes POST only", { allow: "POST" });
    }
    const op = /^\/api\/v1\/([a-z]+)$/.exec(pathname)?.[1];
    // Only the operations that the table lists, not the names that every object has.
    const spec =
      op === "about"
        ? ABOUT
        : op !== undefined && Object.hasOwn(FORWARDED, op)
          ? FORWARDED[op]
          : undefined;
    if (op === undefined || spec === undefined) {
      return problem(404, `the dashboard has no operation at ${pathname}`);
    }
    const body = await readBody(request, bounds.body);
    if (body === undefined) {
      return problem(413, `a request's body takes ${bounds.body} bytes at most`);
    }
    const args = argumentsOf(body, spec);
    if (args === undefined) {
      return problem(400, `${op} takes { "args": [...] } with ${takes(spec)}`);
    }
    if (op === "about") {
      return Response.json({ ok: true, value: { target: watched } }, { headers: NO_STORE });
    }
    if (waiting >= bounds.waiting) {
      return problem(503, `${bounds.waiting} requests already wait for the rack; ask again later`);
    }
    return forward(request, server, op, spec, args);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    // A port that another server holds is refused, not shared. A bug of Bun 1.4.4 sets
    // SO_REUSEPORT for a server with `development: false` unless told not to, so the dashboard
    // would share the port with another dashboard, or with a device's listener, which binds with
    // reusePort: each would take part of the other's connections.
    // @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
    // @decision .agents/decisions/261124_100308-watching-a-fourth-bun-bug.md#the-workaround-stays
    reusePort: false,
    // Bun bundles the page's modules and stylesheet itself, without its development tools, and
    // an executable carries them as rack compile bundled them.
    // @decision .agents/decisions/261124_055114-rack-dashboard.md#how-the-page-is-built
    development: false,
    routes: { "/": page },
    fetch: serve,
  });
  const port = server.port as number;
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    stop: () => server.stop(true),
  };
}

/** What the rack answered to a forwarded request: its body, or why there is none. */
type Answer = { text: string; outcome: string } | { status: 502 | 504; message: string };

/** Sends one operation to the rack's endpoint, found again for it, and waits up to `limit` ms. */
async function ask(
  target: RackTarget,
  op: string,
  args: unknown[],
  limit: number,
  kind: Forwarded["kind"],
): Promise<Answer> {
  const endpoint = await findEndpoint(target);
  if (typeof endpoint === "string") return { status: 502, message: endpoint };
  let response: Response;
  let text: string;
  try {
    // The bound covers the answer's body as well as its arrival.
    const signal = AbortSignal.timeout(limit);
    response = await postOperation(endpoint, op, args, signal);
    text = await response.text();
  } catch (error) {
    if ((error as { name?: unknown }).name === "TimeoutError") {
      const after =
        kind === "operation" ? "; it may still run, and the history will show its outcome" : "";
      return {
        status: 504,
        message: `the rack didn't answer ${op} within ${duration(limit)}${after}`,
      };
    }
    return { status: 502, message: `cannot reach the rack: ${describeError(error)}` };
  }
  // Such as 401 to the token of --url.
  if (!response.ok) {
    return {
      status: 502,
      message: `the rack answered ${response.status} ${response.statusText}`.trimEnd(),
    };
  }
  const outcome = outcomeOf(text);
  if (outcome === undefined) {
    return { status: 502, message: "the answer isn't the JSON of a rack's management endpoint" };
  }
  return { text, outcome };
}

/**
 * Whether a request comes from the dashboard's own page, as far as its headers tell: a `Host`
 * that names loopback, so that no site that points its domain name at `127.0.0.1` gets an
 * answer; no `Origin`, or the dashboard's own; and no `Sec-Fetch-Site`, or `same-origin`.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */
function fromTheDashboard(headers: Headers): boolean {
  const host = headers.get("host");
  if (host === null || !LOOPBACK_HOST.test(host)) return false;
  const origin = headers.get("origin");
  if (origin !== null && origin !== `http://${host}`) return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/** A request's body as text, or `undefined` when it holds more than `limit` bytes. */
async function readBody(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length")) > limit) return undefined;
  if (request.body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  // The declared length may be absent, as for a chunked body, or wrong: the bytes count.
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The arguments of a request's body, `{ "args": [...] }`, when they are as many as the operation
 * takes, and of their kinds; `undefined` otherwise. Without `args`, there are none.
 */
function argumentsOf(body: string, spec: Forwarded): unknown[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: the caller answers 400.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const given = (parsed as { args?: unknown }).args;
  const args = given === undefined ? [] : given;
  if (!Array.isArray(args) || args.length < spec.min || args.length > spec.args.length) {
    return undefined;
  }
  const fits = (arg: unknown, kind: Argument | undefined): boolean =>
    kind === "name"
      ? typeof arg === "string"
      : typeof kind === "object"
        ? fitsOptions(arg, kind)
        : true;
  return args.every((arg, index) => fits(arg, spec.args[index])) ? args : undefined;
}

/**
 * Whether an argument is an object that holds only the options that `options` names, each of its
 * kind, as the page sends them.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-the-dashboard-forwards
 */
function fitsOptions(arg: unknown, options: Readonly<Record<string, Option>>): boolean {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) return false;
  return Object.entries(arg).every(([name, value]) => {
    // Only the options that the table lists, not the names that every object has.
    const kind = Object.hasOwn(options, name) ? options[name] : undefined;
    return kind === "boolean"
      ? typeof value === "boolean"
      : kind === "firmware" && typeof value === "string" && value.length <= FIRMWARE_MAX;
  });
}

/** What an operation takes, for the message of a 400. */
function takes(spec: Forwarded): string {
  const max = spec.args.length;
  const count =
    max === 0
      ? "no arguments"
      : spec.min === max
        ? `${max} argument${max === 1 ? "" : "s"}`
        : `${spec.min} to ${max} arguments`;
  const kinds = spec.args.map((kind) =>
    kind === "name"
      ? "a device's name"
      : typeof kind === "object"
        ? `an object that may hold ${Object.entries(kind)
            .map(([name, option]) => `"${name}", ${OPTION_TEXT[option]}`)
            .join(", and ")}`
        : "a value",
  );
  return kinds.length === 0 ? count : `${count}: ${kinds.join(", then ")}`;
}

/**
 * The outcome of the endpoint's answer, `ok` or the error's code and message; `undefined` for an
 * answer that isn't the endpoint's `{ ok: true, value }` or `{ ok: false, error }`.
 */
function outcomeOf(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: no answer of the endpoint.
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const { ok, error } = body as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  if (ok === true) return "ok";
  if (ok !== false || typeof error?.code !== "string" || typeof error.message !== "string") {
    return undefined;
  }
  return `${error.code}: ${error.message}`;
}

/** An answer of the API without a body, for a refused request. */
function empty(status: number): Response {
  return new Response(null, { status, headers: NO_STORE });
}

/** An answer of the API with a message for people. */
function problem(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers: { ...NO_STORE, ...headers } });
}

/** An argument, as a printed line shows it: a device's name as it is, anything else as JSON. */
function word(arg: unknown): string {
  return typeof arg === "string" ? arg : JSON.stringify(arg);
}

/** A bound in ms, for people: `60 s`, or `10 min` from 2 minutes up. */
function duration(ms: number): string {
  return ms >= 120_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;
}

/** What {@link runDashboard} runs. */
export interface DashboardCommand {
  /** The words after `dashboard`, of which it takes none. */
  positional: readonly string[];
  /** `--port`, `--url`, `--token-file`, and the flag that names the base directory. */
  flags: ReadonlyMap<string, string>;
  /** The base directory of the rack to watch without `--url`. */
  dir: string;
  /** The flag that names the base directory: `--dir`, or in an executable `--base-dir`. */
  dirFlag: "--dir" | "--base-dir";
  /** Prints the usage and exits with code 2. */
  usage: () => never;
}

/**
 * Runs `rack dashboard`, and an executable's `dashboard`: serves the dashboard of the rack that
 * `--url` names, or else of the rack whose base directory is `dir`, and prints its URL. It closes
 * on `SIGINT`, `SIGTERM`, and `SIGBREAK`, and exits with code 0.
 *
 * Exits with code 2 for a wrong command line, such as words after `dashboard`, a `--port` that
 * isn't a port number, `--token-file` without `--url`, or `--url` with the base directory's flag;
 * and with code 1, printing why, when it can't start, such as on a taken `--port` or a token file
 * that it can't read.
 */
export async function runDashboard(command: DashboardCommand): Promise<void> {
  const { flags, usage } = command;
  if (command.positional.length > 0) usage();
  const port = Number(flags.get("--port") ?? 0);
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) usage();
  const url = flags.get("--url");
  if (url === undefined && flags.has("--token-file")) usage();
  if (url !== undefined && (flags.has(command.dirFlag) || !isHttpUrl(url))) usage();

  let dashboard: Dashboard | undefined;
  let stopping = false;
  // Installed before the server listens, so that a signal during start-up still exits with 0.
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    void (dashboard?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Ctrl+Break on Windows, which has no SIGTERM. Other systems never send it.
  // @decision .agents/decisions/261118_015204-windows.md#changes-to-the-rack
  process.on("SIGBREAK", onSignal);

  const target = await rackTarget(flags, command.dir);
  try {
    dashboard = openDashboard({ target, port });
  } catch (error) {
    fail(`cannot listen on 127.0.0.1:${port}: ${describeError(error)}`);
  }
  // The only line that holds the token.
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
  console.log(
    oneLine(`dashboard of ${"url" in target ? target.url : target.dir} at ${dashboard.url}`),
  );
}

/** Whether a `--url` is an `http:` or `https:` URL, as a TCP endpoint's is. */
function isHttpUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:";
}
