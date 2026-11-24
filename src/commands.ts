/**
 * What the `rack` command and an executable that `rack compile` made share: their arguments,
 * running a rack with its management endpoint until a signal, `rack ctl stop`, or the end of
 * standard input stops it, printing a plan, sending an operation to a running rack, and finding
 * that rack's endpoint, which `rack dashboard` also reaches it by.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#commands-and-management
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-command
 * @decision .agents/decisions/261118_173838-running-under-another-program.md
 * @decision .agents/decisions/261120_011627-single-executables.md#running-an-executable
 * @decision .agents/decisions/261120_221450-watching-outside-files.md#on-command-or-as-files-change
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#rack-dashboard
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { alive, type Control, type ControlFile, controlPaths, openControl } from "./control.ts";
import { isDeviceFileOrJson, type WatchOptions, watchAndReload } from "./dev.ts";
import { RackError } from "./errors.ts";
import { consoleLogger, jsonLogger, type LogEntry } from "./log.ts";
import { isRackManifest, type RackManifest } from "./manifest.ts";
import { planRack, type RackHandle, reloadHotplug, start, sweepUnneededFirmware } from "./rack.ts";

/** The program that messages name: `rack`, or an executable's own name. */
let program = "rack";

/** Names the program in the messages that {@link fail} prints. */
export function setProgram(name: string): void {
  program = name;
}

/** Prints a message on standard error and exits with code 1. */
export function fail(message: string): never {
  console.error(`${program}: ${message}`);
  process.exit(1);
}

/** An error's code, when it has one, and message. */
export function describeError(error: unknown): string {
  const code = error instanceof RackError ? `${error.code}: ` : "";
  return `${code}${error instanceof Error ? error.message : String(error)}`;
}

/** Arguments split into positional ones and flags. */
export interface Arguments {
  positional: string[];
  flags: Map<string, string>;
}

/**
 * Splits arguments into positional ones and flags.
 *
 * @param valueFlags Flags that take a value, as `--flag value` or `--flag=value`.
 * @param usage Prints the usage and exits; called on a malformed flag.
 */
export function parseArgs(
  args: string[],
  valueFlags: ReadonlySet<string>,
  usage: () => never,
): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    if (!valueFlags.has(name)) {
      if (inline !== undefined) usage();
      flags.set(name, "");
      continue;
    }
    const value = inline ?? args[++index];
    if (value === undefined || value === "") usage();
    flags.set(name, value);
  }
  return { positional, flags };
}

/** Loads the default export of a manifest file; exits when it isn't a rack. */
export async function loadManifest(manifestPath: string): Promise<RackManifest> {
  let manifest: unknown;
  try {
    manifest = ((await import(manifestPath)) as { default?: unknown }).default;
  } catch (error) {
    fail(`cannot load ${manifestPath}: ${describeError(error)}`);
  }
  if (!isRackManifest(manifest)) fail(`${manifestPath} does not default-export a rack()`);
  return manifest;
}

/**
 * Prints the plan of a rack. With `--write`, writes the plan file of a scanned rack; with
 * `--check`, exits with code 1 when that file is missing or no longer fits the devices.
 */
export async function printPlan(
  manifestPath: string,
  flags: ReadonlyMap<string, string>,
): Promise<void> {
  if (flags.has("--write") && flags.has("--check")) fail("--write and --check exclude each other");
  const manifest = await loadManifest(manifestPath);
  if (manifest.scan === undefined && (flags.has("--write") || flags.has("--check"))) {
    fail(`${manifestPath} places devices by hand, so it has no plan file`);
  }
  // Plan output goes to stdout; only the rack's warnings and errors reach stderr.
  const logger = (entry: LogEntry) => {
    if (entry.level === "warn" || entry.level === "error") consoleLogger(entry);
  };
  let report: Awaited<ReturnType<typeof planRack>>;
  try {
    report = await planRack(
      manifest,
      { baseDir: dirname(manifestPath), logger },
      flags.has("--write"),
    );
  } catch (error) {
    fail(describeError(error));
  }
  process.stdout.write(report.text);
  if (report.unused.length > 0) console.log(`# unused models: ${report.unused.join(", ")}`);
  // Hot-plug devices aren't in the plan file: they come and go with their files.
  // @decision .agents/decisions/261121_065823-hot-plug-directories.md#observation
  for (const line of report.hotplug) console.log(`# hot-plug ${line}`);
  for (const { path, reason } of report.leftOut) console.log(`# left out ${path}: ${reason}`);
  const file = report.file;
  if (file === undefined) return;
  const where = file.path;
  if (file.state === "fits") console.log(`# ${where} fits`);
  if (file.state === "reordered") {
    console.log(
      `# ${where} fits, with another order than the priorities give; --write applies them`,
    );
  }
  if (file.state === "missing") console.log(`# ${where} does not exist; --write creates it`);
  if (file.state === "differs") {
    console.log(`# ${where} no longer fits:`);
    for (const difference of file.differences) console.log(`#   ${difference}`);
  }
  if (flags.has("--check") && (file.state === "missing" || file.state === "differs")) {
    process.exit(1);
  }
}

/**
 * Sends one operation to a running rack and prints its result as JSON. The rack is the one whose
 * base directory is `dir`, or the TCP endpoint at `--url`.
 *
 * Without `--url`, the token is the control file's, which goes out only while the process that
 * the file names runs. With `--url`, it is the first line of `--token-file`, or else
 * `RACK_CONTROL_TOKEN`; no token goes on the command line, where other users could read it.
 *
 * @param positional The operation and its arguments.
 * @param dir The base directory of the rack to reach without `--url`.
 * @param usage Prints the usage and exits; called on malformed arguments.
 */
export async function sendOperation(
  positional: string[],
  flags: ReadonlyMap<string, string>,
  dir: string,
  usage: () => never,
): Promise<void> {
  const [op = "", ...rest] = positional;
  const args = ctlArgs(op, rest, flags, usage);
  const endpoint = await findEndpoint(await rackTarget(flags, dir));
  if (typeof endpoint === "string") fail(endpoint);
  let response: Response;
  try {
    response = await postOperation(endpoint, op, args);
  } catch (error) {
    fail(`cannot reach the rack: ${describeError(error)}`);
  }
  if (!response.ok) fail(`the rack answered ${response.status} ${response.statusText}`);
  const body = (await response.json()) as
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) fail(`${body.error.code}: ${body.error.message}`);
  console.log(JSON.stringify(body.value, null, 2));
}

/**
 * The rack that a command reaches: the one whose base directory is a path, or the one whose TCP
 * endpoint answers at a URL, with its token.
 */
export type RackTarget = { dir: string } | { url: string; token: string };

/** A running rack's management endpoint, as {@link findEndpoint} finds it. */
export interface Endpoint {
  /** The origin that operations go to: `http://localhost` on a Unix socket. */
  url: string;
  /** The path of the Unix socket, when the endpoint is one. */
  unix?: string;
  /** The bearer token of a TCP endpoint. */
  token?: string;
}

/**
 * The rack that `--url` names, with the token on the first line of `--token-file`, or else in
 * `RACK_CONTROL_TOKEN`; without `--url`, the rack whose base directory is `dir`. No token goes
 * on the command line, where other users could read it.
 *
 * Exits with code 1, printing why, for `--token-file` without `--url`, a token file that it can't
 * read or whose first line is empty, and `--url` without a token.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
 */
export async function rackTarget(
  flags: ReadonlyMap<string, string>,
  dir: string,
): Promise<RackTarget> {
  const url = flags.get("--url");
  const tokenFile = flags.get("--token-file");
  if (url === undefined) {
    if (tokenFile !== undefined) fail("--token-file goes with --url");
    return { dir };
  }
  const token = tokenFile === undefined ? process.env.RACK_CONTROL_TOKEN : await tokenIn(tokenFile);
  if (token === undefined) fail("--url needs --token-file or RACK_CONTROL_TOKEN");
  return { url, token };
}

/**
 * Finds the management endpoint of a running rack, as `rack ctl` and `rack dashboard` reach it.
 * For a base directory, it is the rack's Unix socket, or else the URL and token in its control
 * file, which it reads at each call, so that it finds a rack that started since the last one.
 * A URL target is its own endpoint.
 *
 * @returns The endpoint, or a message for people when no running rack has the base directory,
 *   or its control file can't be read.
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#rack-dashboard
 */
export async function findEndpoint(target: RackTarget): Promise<Endpoint | string> {
  if ("url" in target) return { url: target.url, token: target.token };
  const paths = controlPaths(target.dir);
  const none = `no running rack has the base directory ${target.dir}`;
  if (process.platform !== "win32" && existsSync(paths.socket)) {
    return { url: "http://localhost", unix: paths.socket };
  }
  if (!existsSync(paths.file)) return none;
  let file: Partial<ControlFile>;
  try {
    file = (await Bun.file(paths.file).json()) as Partial<ControlFile>;
  } catch (error) {
    // The rack removes its file as it stops, which may come between the check and the read.
    if (!existsSync(paths.file)) return none;
    return `cannot read the control file ${paths.file}: ${describeError(error)}`;
  }
  if (
    typeof file.url !== "string" ||
    typeof file.token !== "string" ||
    typeof file.pid !== "number"
  ) {
    return `the control file ${paths.file} has no url, token, and pid`;
  }
  // A file left by a rack that ended names a process that no longer runs; its token would go to
  // whatever listens on its port now.
  if (!alive(file.pid)) return none;
  return { url: file.url, token: file.token };
}

/**
 * Posts one operation to a management endpoint, as `{ "args": [...] }`, directly: never through
 * a proxy that `HTTP_PROXY` names.
 *
 * @param signal Aborts the request, and the reading of its answer.
 * @returns The endpoint's answer.
 * @throws What `fetch` throws when nothing answers, or when `signal` aborts.
 */
export function postOperation(
  endpoint: Endpoint,
  op: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${endpoint.url}/v1/${op}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(endpoint.token === undefined ? {} : { authorization: `Bearer ${endpoint.token}` }),
    },
    body: JSON.stringify({ args }),
    // The endpoint listens on loopback. Bun's fetch sends a request for 127.0.0.1 through the
    // proxy of HTTP_PROXY unless NO_PROXY names it, and the token with it.
    // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
    proxy: false,
    ...(endpoint.unix === undefined ? {} : { unix: endpoint.unix }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The token on the first line of a file, for `--token-file`. */
async function tokenIn(path: string): Promise<string> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    fail(`cannot read the token file ${path}: ${describeError(error)}`);
  }
  const token = text.split(/\r?\n/, 1)[0] ?? "";
  if (token === "") fail(`the token file ${path} has no token on its first line`);
  return token;
}

/** The arguments of a `rack ctl` operation, from its command-line words and flags. */
function ctlArgs(
  op: string,
  rest: string[],
  flags: ReadonlyMap<string, string>,
  usage: () => never,
): unknown[] {
  const at = (min: number, max: number) => {
    if (rest.length < min || rest.length > max) usage();
  };
  switch (op) {
    case "status":
    case "metrics":
    case "reload":
    case "stop":
      at(0, 0);
      return [];
    case "swap":
      at(1, 2);
      return rest;
    case "restart":
      at(1, 1);
      return flags.has("--no-cascade") ? [rest[0], { cascade: false }] : rest;
    case "rollback": {
      at(1, 1);
      const to = flags.get("--to");
      return to === undefined ? rest : [rest[0], { to }];
    }
    case "history":
      at(0, 1);
      return rest;
    default:
      return usage();
  }
}

/** What {@link runRack} runs. */
export interface RunOptions {
  /** `start`, or `dev`, which keeps a scanned rack's plan file in step with its devices. */
  command: "start" | "dev";
  /** Loads the manifest, once the signals that stop the rack are handled. */
  manifest: () => Promise<RackManifest>;
  baseDir: string;
  /** The flags of `rack start`. */
  flags: ReadonlyMap<string, string>;
  /** Prints the usage and exits; called on a malformed flag. */
  usage: () => never;
  /**
   * Watches the base directory once the rack runs, and reloads it after changes: for `rack dev`,
   * with its manifest file, and for an executable with `--watch`, with the changes that count.
   */
  watch?: Omit<WatchOptions, "baseDir" | "log">;
}

/**
 * Runs a rack with its management endpoint, and shuts it down in order on `SIGINT`, `SIGTERM`,
 * `SIGBREAK`, `rack ctl stop`, and with `--stop-on-stdin-close` when standard input closes.
 */
export async function runRack(options: RunOptions): Promise<void> {
  const { command, baseDir, flags, usage } = options;
  const portFlag = flags.get("--control-port");
  const port = portFlag === undefined ? undefined : Number(portFlag);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) usage();
  const format = flags.get("--log") ?? "text";
  if (format !== "text" && format !== "json") usage();
  // @decision .agents/decisions/261118_173838-running-under-another-program.md#logs-as-json
  const logger = format === "json" ? jsonLogger : consoleLogger;

  let running: RackHandle | undefined;
  let control: Control | undefined;
  let unwatch: (() => void) | undefined;
  let stopping = false;
  const stop = async (rack: RackHandle) => {
    await control?.close().catch(() => undefined);
    await rack.stop().then(
      () => process.exit(0),
      (error: unknown) => fail(`shutdown failed: ${describeError(error)}`),
    );
  };
  // Installed before the rack starts, so a signal during start-up still shuts down in order.
  const onSignal = (signal: NodeJS.Signals | "stdin") => {
    if (stopping) {
      const what = signal === "stdin" ? "standard input closed" : `${signal} again`;
      console.error(`${program}: ${what}, exiting without finishing the shutdown`);
      process.exit(1);
    }
    stopping = true;
    unwatch?.();
    if (running !== undefined) void stop(running);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Ctrl+Break on Windows, which has no SIGTERM. Other systems never send it.
  // @decision .agents/decisions/261118_015204-windows.md#changes-to-the-rack
  process.on("SIGBREAK", onSignal);
  // A program that runs the rack stops it by closing the pipe, which the system also closes when
  // the program ends for any reason.
  // @decision .agents/decisions/261118_173838-running-under-another-program.md#stopping-when-standard-input-closes
  if (flags.has("--stop-on-stdin-close")) {
    void (async () => {
      try {
        for await (const _chunk of Bun.stdin.stream()) {
          // What arrives is dropped: only the end of the input matters.
        }
      } catch {
        // A read that fails ends the input as surely as a close does.
      }
      if (!stopping) logger({ time: Date.now(), level: "info", message: "standard input closed" });
      onSignal("stdin");
    })();
  }

  const manifest = await options.manifest();
  // rack dev keeps the plan file in step with the devices; rack start follows it.
  // @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
  const planMode = flags.has("--no-plan") ? false : command === "dev" ? "update" : true;
  // @decision .agents/decisions/261117_062959-watchdog.md#configuration-and-observation
  const watchdog = flags.has("--no-watchdog") ? { watchdog: 0 } : {};
  try {
    running = await start(manifest, {
      baseDir,
      logger,
      plan: planMode,
      ...watchdog,
    });
  } catch (error) {
    fail(describeError(error));
  }
  if (stopping) {
    await stop(running);
    return;
  }
  // rack ctl stop shuts down the same way as a signal.
  // @decision .agents/decisions/261117_005821-management-endpoint.md#the-protocol
  try {
    control = await openControl(running, {
      baseDir,
      ...(port === undefined ? {} : { port }),
      stop: () => onSignal("SIGTERM"),
    });
  } catch (error) {
    await running.stop().catch(() => undefined);
    fail(describeError(error));
  }
  // The endpoint makes this the one rack of its base directory, which may now delete the
  // firmware that earlier runs left.
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
  await sweepUnneededFirmware(running).catch((error: unknown) => {
    logger({
      time: Date.now(),
      level: "warn",
      message: "firmware of earlier runs couldn't be deleted",
      data: { error: describeError(error) },
    });
  });
  logger({
    time: Date.now(),
    level: "info",
    message: "control listening",
    data: { address: control.address },
  });
  if (options.watch !== undefined) {
    unwatch = watchAndReload(running, { ...options.watch, baseDir, log: logger });
  }
  // rack start watches the hot-plug directories, and applies the hot-plug devices' changes
  // alone; the fixed devices change at rack ctl reload. rack dev's watch applies them with the
  // rest.
  // @decision .agents/decisions/261121_065823-hot-plug-directories.md#when-changes-apply
  const hotplug = manifest.scan?.hotplug ?? [];
  if (command === "start" && options.watch === undefined && hotplug.length > 0) {
    const handle = running;
    const inside = (path: string) => {
      const relative = path.replaceAll("\\", "/");
      return hotplug.some((dir) => relative === dir || relative.startsWith(`${dir}/`));
    };
    unwatch = watchAndReload(
      { reload: () => reloadHotplug(handle) },
      {
        baseDir,
        log: logger,
        counts: (path) => inside(path) && isDeviceFileOrJson(path),
        what: `the hot-plug directories ${hotplug.map((dir) => `${dir}/`).join(", ")}`,
      },
    );
  }
}
