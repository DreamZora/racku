/**
 * What the `rack` command and an executable that `rack compile` made share: their arguments,
 * running a rack with its management endpoint until a signal, `rack ctl stop`, or the end of
 * standard input stops it, printing a plan, and sending an operation to a running rack.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#commands-and-management
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-command
 * @decision .agents/decisions/261118_173838-running-under-another-program.md
 * @decision .agents/decisions/261120_011627-single-executables.md#running-an-executable
 * @decision .agents/decisions/261120_221450-watching-outside-files.md#on-command-or-as-files-change
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { type Control, type ControlFile, controlPaths, openControl } from "./control.ts";
import { type WatchOptions, watchAndReload } from "./dev.ts";
import { RackError } from "./errors.ts";
import { consoleLogger, jsonLogger, type LogEntry } from "./log.ts";
import { isRackManifest, type RackManifest } from "./manifest.ts";
import { planRack, type RackHandle, start } from "./rack.ts";

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
  let url = flags.get("--url");
  let token = flags.get("--token") ?? process.env.RACK_CONTROL_TOKEN;
  let unix: string | undefined;
  if (url === undefined) {
    const paths = controlPaths(dir);
    if (process.platform !== "win32" && existsSync(paths.socket)) unix = paths.socket;
    else if (existsSync(paths.file)) {
      const file = (await Bun.file(paths.file).json()) as ControlFile;
      url = file.url;
      token = file.token;
    } else fail(`no running rack has the base directory ${dir}`);
  } else if (token === undefined) {
    fail("--url needs --token or RACK_CONTROL_TOKEN");
  }
  let response: Response;
  try {
    response = await fetch(`${url ?? "http://localhost"}/v1/${op}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined || unix !== undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ args }),
      ...(unix === undefined ? {} : { unix }),
    });
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
  logger({
    time: Date.now(),
    level: "info",
    message: "control listening",
    data: { address: control.address },
  });
  if (options.watch !== undefined) {
    unwatch = watchAndReload(running, { ...options.watch, baseDir, log: logger });
  }
}
