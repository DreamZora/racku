#!/usr/bin/env bun
/**
 * The `rack` command line: `rack start [manifest]`, `rack dev [manifest]`, and
 * `rack plan [manifest]`.
 *
 * Every command loads the manifest, which references devices only by path, and uses the
 * manifest's directory as the base directory. `start` and `dev` run the rack and shut down in
 * order on `SIGINT` or `SIGTERM`; `plan` prints the plan without starting the rack.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#commands-and-management
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 */
import { dirname, resolve } from "node:path";
import { watchAndReload } from "./dev.ts";
import { RackError } from "./errors.ts";
import { consoleLogger, type LogEntry } from "./log.ts";
import { isRackManifest, type RackManifest } from "./manifest.ts";
import { planRack, type RackHandle, start } from "./rack.ts";

const USAGE = [
  "usage: rack <start|dev> [manifest path, default rack.ts] [--no-plan]",
  "       rack plan [manifest path, default rack.ts] [--write | --check]",
].join("\n");

const FLAGS: Record<string, readonly string[]> = {
  start: ["--no-plan"],
  dev: ["--no-plan"],
  plan: ["--write", "--check"],
};

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
async function plan(manifestPath: string, flags: Set<string>): Promise<void> {
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

async function main(args: string[]): Promise<void> {
  const [command = "", ...rest] = args;
  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const known = FLAGS[command];
  if (
    known === undefined ||
    positional.length > 1 ||
    [...flags].some((flag) => !known.includes(flag))
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  const manifestPath = resolve(positional[0] ?? "rack.ts");
  if (command === "plan") {
    await plan(manifestPath, flags);
    return;
  }

  let running: RackHandle | undefined;
  let unwatch: (() => void) | undefined;
  let stopping = false;
  const stop = (rack: RackHandle) =>
    rack.stop().then(
      () => process.exit(0),
      (error: unknown) => fail(`shutdown failed: ${describe(error)}`),
    );
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
  if (command === "dev") {
    unwatch = watchAndReload(running, { baseDir, manifestPath, log: consoleLogger });
  }
}

await main(process.argv.slice(2));
