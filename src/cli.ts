#!/usr/bin/env bun
/**
 * The `rack` command line: `rack start [manifest]`, `rack dev [manifest]`, `rack plan [manifest]`,
 * and `rack ctl <operation>`.
 *
 * `start`, `dev`, and `plan` load the manifest, which references devices only by path, and use
 * the manifest's directory as the base directory. `start` and `dev` run the rack with its
 * management endpoint, and shut down in order on `SIGINT`, `SIGTERM`, or `rack ctl stop`; `plan`
 * prints the plan without starting the rack. `ctl` sends one operation to a running rack.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#commands-and-management
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-command
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Control, type ControlFile, controlPaths, openControl } from "./control.ts";
import { watchAndReload } from "./dev.ts";
import { RackError } from "./errors.ts";
import { consoleLogger, type LogEntry } from "./log.ts";
import { isRackManifest, type RackManifest } from "./manifest.ts";
import { planRack, type RackHandle, start } from "./rack.ts";

const USAGE = [
  "usage: rack <start|dev> [manifest path, default rack.ts] [--no-plan] [--control-port <port>]",
  "       rack plan [manifest path, default rack.ts] [--write | --check]",
  "       rack ctl status | metrics | reload | stop",
  "       rack ctl swap <device> [source] | restart <device> [--no-cascade]",
  "       rack ctl rollback <device> [--to <firmware>] | history [device]",
  "         [--dir <base directory>] [--url <url> --token <token>]",
].join("\n");

const FLAGS: Record<string, readonly string[]> = {
  start: ["--no-plan", "--control-port"],
  dev: ["--no-plan", "--control-port"],
  plan: ["--write", "--check"],
  ctl: ["--dir", "--url", "--token", "--no-cascade", "--to"],
};

/** Flags that take a value, as `--flag value` or `--flag=value`. */
const VALUE_FLAGS = new Set(["--control-port", "--dir", "--url", "--token", "--to"]);

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

/** Splits arguments into positional ones and flags; exits with the usage on a malformed one. */
function parse(args: string[]): { positional: string[]; flags: Map<string, string> } {
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
    if (!VALUE_FLAGS.has(name)) {
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

function fail(message: string): never {
  console.error(`rack: ${message}`);
  process.exit(1);
}

function describe(error: unknown): string {
  const code = error instanceof RackError ? `${error.code}: ` : "";
  return `${code}${error instanceof Error ? error.message : String(error)}`;
}

/** Loads the default export of a manifest file. */
async function load(manifestPath: string): Promise<RackManifest> {
  let manifest: unknown;
  try {
    manifest = ((await import(manifestPath)) as { default?: unknown }).default;
  } catch (error) {
    fail(`cannot load ${manifestPath}: ${describe(error)}`);
  }
  if (!isRackManifest(manifest)) fail(`${manifestPath} does not default-export a rack()`);
  return manifest;
}

/**
 * Prints the plan of a rack. With `--write`, writes the plan file of a scanned rack; with
 * `--check`, exits with code 1 when that file is missing or no longer fits the devices.
 */
async function plan(manifestPath: string, flags: ReadonlyMap<string, string>): Promise<void> {
  if (flags.has("--write") && flags.has("--check")) fail("--write and --check exclude each other");
  const manifest = await load(manifestPath);
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
    fail(describe(error));
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
 * base directory is `--dir`, by default the working directory, or the TCP endpoint at `--url`.
 */
async function ctl(positional: string[], flags: ReadonlyMap<string, string>): Promise<void> {
  const [op = "", ...rest] = positional;
  const args = ctlArgs(op, rest, flags);
  let url = flags.get("--url");
  let token = flags.get("--token") ?? process.env.RACK_CONTROL_TOKEN;
  let unix: string | undefined;
  if (url === undefined) {
    const dir = resolve(flags.get("--dir") ?? process.cwd());
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
    fail(`cannot reach the rack: ${describe(error)}`);
  }
  if (!response.ok) fail(`the rack answered ${response.status} ${response.statusText}`);
  const body = (await response.json()) as
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) fail(`${body.error.code}: ${body.error.message}`);
  console.log(JSON.stringify(body.value, null, 2));
}

/** The arguments of a `rack ctl` operation, from its command-line words and flags. */
function ctlArgs(op: string, rest: string[], flags: ReadonlyMap<string, string>): unknown[] {
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

async function main(args: string[]): Promise<void> {
  const [command = "", ...rest] = args;
  const { positional, flags } = parse(rest);
  const known = FLAGS[command];
  if (known === undefined || [...flags.keys()].some((flag) => !known.includes(flag))) usage();
  if (command === "ctl") {
    await ctl(positional, flags);
    return;
  }
  if (positional.length > 1) usage();
  const manifestPath = resolve(positional[0] ?? "rack.ts");
  if (command === "plan") {
    await plan(manifestPath, flags);
    return;
  }
  const portFlag = flags.get("--control-port");
  const port = portFlag === undefined ? undefined : Number(portFlag);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) usage();

  let running: RackHandle | undefined;
  let control: Control | undefined;
  let unwatch: (() => void) | undefined;
  let stopping = false;
  const stop = async (rack: RackHandle) => {
    await control?.close().catch(() => undefined);
    await rack.stop().then(
      () => process.exit(0),
      (error: unknown) => fail(`shutdown failed: ${describe(error)}`),
    );
  };
  // Installed before the rack starts, so a signal during start-up still shuts down in order.
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      console.error(`rack: ${signal} again, exiting without finishing the shutdown`);
      process.exit(1);
    }
    stopping = true;
    unwatch?.();
    if (running !== undefined) void stop(running);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const manifest = await load(manifestPath);
  const baseDir = dirname(manifestPath);
  // rack dev keeps the plan file in step with the devices; rack start follows it.
  // @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
  const planMode = flags.has("--no-plan") ? false : command === "dev" ? "update" : true;
  try {
    running = await start(manifest, { baseDir, logger: consoleLogger, plan: planMode });
  } catch (error) {
    fail(describe(error));
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
    fail(describe(error));
  }
  consoleLogger({
    time: Date.now(),
    level: "info",
    message: "control listening",
    data: { address: control.address },
  });
  if (command === "dev") {
    unwatch = watchAndReload(running, { baseDir, manifestPath, log: consoleLogger });
  }
}

await main(process.argv.slice(2));
