/**
 * The management endpoint: an HTTP server that runs the operations of the rack handle for
 * `rack ctl`. On Linux and macOS it listens on a Unix socket that only its user can reach; on
 * Windows, or when a port is given, on loopback TCP with a bearer token.
 *
 * @decision .agents/decisions/261117_005821-management-endpoint.md#transports
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-unix-socket
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-tcp-endpoint
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-protocol
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { RackError, toWireError } from "./errors.ts";
import { slot } from "./manifest.ts";
import type { RackHandle } from "./rack.ts";

/** How {@link openControl} listens. */
export interface ControlOptions {
  /** Absolute base directory of the rack; it names the socket and the control file. */
  baseDir: string;
  /** Listen on loopback TCP at this port, 0 for a free one, instead of the platform's default. */
  port?: number;
  /** The bearer token of the TCP endpoint; by default a random one. */
  token?: string;
  /** Runs for the `stop` operation, after its answer has gone out. */
  stop: () => void;
}

/** A running management endpoint. */
export interface Control {
  /** `unix:<path>` for a socket, or the `http://127.0.0.1:<port>` URL. */
  readonly address: string;
  /** Stops listening and removes the socket or the control file. */
  close(): Promise<void>;
}

/** What `rack ctl` reads to reach a TCP endpoint. */
export interface ControlFile {
  url: string;
  token: string;
  pid: number;
}

/** The operations of the rack handle that the endpoint serves, with their numbers of arguments. */
const OPERATIONS: Record<string, readonly [min: number, max: number]> = {
  status: [0, 0],
  metrics: [0, 0],
  reload: [0, 0],
  swap: [1, 2],
  restart: [1, 2],
  rollback: [1, 2],
  history: [0, 1],
  plug: [2, 2],
  unplug: [1, 1],
  stop: [0, 0],
};

/**
 * Where a rack's endpoint lives, from its base directory:
 * - Windows: the control file under `%LOCALAPPDATA%\\rack42u\\control\\`.
 * - Elsewhere: `$XDG_RUNTIME_DIR/rack42u/`, or `~/.local/state/rack42u/control/`, for both the
 *   socket and the control file. These paths stay short, under the socket path limits.
 *
 * Their names come from a hash of the directory's real path, so every path that leads to the
 * directory, such as one through a symlink, finds the same endpoint.
 */
export function controlPaths(
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
): { dir: string; socket: string; file: string } {
  const key = new Bun.CryptoHasher("sha256").update(realPath(baseDir)).digest("hex").slice(0, 16);
  // The paths follow the platform asked for, not the one this runs on.
  const { join } = platform === "win32" ? win32 : posix;
  let dir: string;
  if (platform === "win32") {
    dir = join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "rack42u",
      "control",
    );
  } else if (process.env.XDG_RUNTIME_DIR) {
    dir = join(process.env.XDG_RUNTIME_DIR, "rack42u");
  } else {
    dir = join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "rack42u",
      "control",
    );
  }
  return { dir, socket: join(dir, `${key}.sock`), file: join(dir, `${key}.json`) };
}

/** A directory's path with its symlinks resolved, or as given when it doesn't resolve. */
function realPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    // A path that doesn't resolve, such as a directory that doesn't exist, has no rack to find,
    // so its spelling serves as the key.
    return dir;
  }
}

/**
 * The transport an endpoint uses: loopback TCP when a port is given or on Windows, where Bun's
 * support for Unix sockets is unverified, and a Unix socket otherwise.
 */
export function controlTransport(
  port: number | undefined,
  platform: NodeJS.Platform = process.platform,
): "unix" | "tcp" {
  return port !== undefined || platform === "win32" ? "tcp" : "unix";
}

/**
 * Opens the management endpoint of a running rack.
 *
 * @throws RackError `RACK_MANIFEST` when another rack already answers for the same base
 *   directory, or the endpoint cannot listen.
 */
export async function openControl(handle: RackHandle, options: ControlOptions): Promise<Control> {
  const paths = controlPaths(options.baseDir);
  // Only the user who runs the rack may enter the directory; it holds the socket or the token.
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(paths.dir, 0o700);
  return controlTransport(options.port) === "tcp"
    ? openTcp(handle, options, paths)
    : openUnix(handle, options, paths);
}

async function openUnix(
  handle: RackHandle,
  options: ControlOptions,
  paths: { socket: string },
): Promise<Control> {
  if (existsSync(paths.socket)) {
    if (await answers({ unix: paths.socket })) {
      throw new RackError(
        "RACK_MANIFEST",
        `another rack already answers on ${paths.socket}; stop it before starting this one`,
      );
    }
    // Left over from a rack that exited without removing it.
    await unlink(paths.socket).catch(() => {
      // It may have gone in the meantime; listening below reports any other problem.
    });
  }
  const server = listen(() =>
    Bun.serve({ unix: paths.socket, fetch: (request) => serve(handle, options, request, null) }),
  );
  // The private directory keeps others out until the mode tightens.
  await chmod(paths.socket, 0o600);
  return {
    address: `unix:${paths.socket}`,
    close: async () => {
      await server.stop(true);
      await unlink(paths.socket).catch(() => {
        // Bun removes the socket when the server stops.
      });
    },
  };
}

async function openTcp(
  handle: RackHandle,
  options: ControlOptions,
  paths: { file: string },
): Promise<Control> {
  const existing = Bun.file(paths.file);
  if (await existing.exists()) {
    const previous = (await existing.json().catch(() => undefined)) as ControlFile | undefined;
    if (previous !== undefined && previous.pid !== process.pid && alive(previous.pid)) {
      throw new RackError(
        "RACK_MANIFEST",
        `another rack, process ${previous.pid}, already answers for this base directory`,
      );
    }
  }
  const token =
    options.token ?? process.env.RACK_CONTROL_TOKEN ?? randomBytes(32).toString("base64url");
  let host = "";
  const server = listen(() =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 0,
      fetch: (request) => serve(handle, options, request, { token, host }),
    }),
  );
  host = `127.0.0.1:${server.port}`;
  const url = `http://${host}`;
  const file: ControlFile = { url, token, pid: process.pid };
  await Bun.write(paths.file, JSON.stringify(file));
  if (process.platform !== "win32") await chmod(paths.file, 0o600);
  return {
    address: url,
    close: async () => {
      await server.stop(true);
      await unlink(paths.file).catch(() => {
        // Already removed; nothing names this rack any more.
      });
    },
  };
}

function listen(open: () => Bun.Server<undefined>): Bun.Server<undefined> {
  try {
    return open();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RackError("RACK_MANIFEST", `the management endpoint cannot listen: ${message}`);
  }
}

/** Whether a process with this id runs, as far as this user can tell. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs as another user, which still counts as running.
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Whether anything answers HTTP on the socket. */
async function answers(target: { unix: string }): Promise<boolean> {
  try {
    await fetch("http://localhost/v1/status", { method: "POST", unix: target.unix, body: "{}" });
    return true;
  } catch {
    // Nothing listens: the socket is stale.
    return false;
  }
}

/**
 * Serves one request. `tcp` carries the token and the expected `Host` of the TCP endpoint; it is
 * `null` on the Unix socket, whose file permissions already decide who connects.
 */
async function serve(
  handle: RackHandle,
  options: ControlOptions,
  request: Request,
  tcp: { token: string; host: string } | null,
): Promise<Response> {
  if (tcp !== null) {
    // A web page on the same machine can reach loopback; only a page sends Origin, and a page
    // that points its own domain name at 127.0.0.1 still sends its own name as Host.
    // @decision .agents/decisions/261117_005821-management-endpoint.md#the-tcp-endpoint
    if (request.headers.has("origin") || request.headers.get("host") !== tcp.host) {
      return new Response(null, { status: 403 });
    }
    const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    const wanted = Buffer.from(tcp.token);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      return new Response(null, { status: 401 });
    }
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const op = /^\/v1\/([a-z]+)$/.exec(new URL(request.url).pathname)?.[1];
  const arity = op === undefined ? undefined : OPERATIONS[op];
  if (op === undefined || arity === undefined) return new Response(null, { status: 404 });
  let args: unknown[];
  try {
    const body = (await request.json()) as { args?: unknown };
    args = body.args === undefined ? [] : (body.args as unknown[]);
    if (!Array.isArray(args) || args.length < arity[0] || args.length > arity[1]) throw new Error();
  } catch {
    // Not JSON, or not { args: [...] } with the operation's number of arguments.
    return new Response(null, { status: 400 });
  }
  if (op === "stop") {
    // The answer goes out before the rack stops, which closes this endpoint too.
    setTimeout(options.stop, 0);
    return Response.json({ ok: true, value: null });
  }
  try {
    return Response.json({ ok: true, value: (await run(handle, op, args)) ?? null });
  } catch (error) {
    return Response.json({ ok: false, error: toWireError(error) });
  }
}

/** Runs one operation of the rack handle with the arguments it came with. */
function run(handle: RackHandle, op: string, args: unknown[]): unknown {
  const [first, second] = args as [unknown, unknown];
  switch (op) {
    case "status":
      return handle.status();
    case "metrics":
      return handle.metrics();
    case "reload":
      return handle.reload();
    case "swap":
      return handle.swap(first as string, second as string | undefined);
    case "restart":
      return handle.restart(first as string, (second ?? {}) as { cascade?: boolean });
    case "rollback":
      return handle.rollback(first as string, (second ?? {}) as { to?: string });
    case "history":
      return handle.history(first as string | undefined);
    case "plug": {
      const spec = (second ?? {}) as { source?: unknown; name?: string; config?: unknown };
      if (typeof spec.source !== "string") {
        throw new RackError("RACK_MANIFEST", "plug takes { source, name?, config? }");
      }
      return handle.plug(
        first as number,
        slot(spec.source, { name: spec.name, config: spec.config }),
      );
    }
    case "unplug":
      return handle.unplug(first as string);
    default:
      throw new RackError("RACK_NO_ROUTE", `no operation ${op}`);
  }
}
