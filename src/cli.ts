#!/usr/bin/env bun
/**
 * The `rack` command line: `rack start [manifest]`, `rack dev [manifest]`, `rack plan [manifest]`,
 * `rack compile [manifest]`, and `rack ctl <operation>`.
 *
 * `start`, `dev`, `plan`, and `compile` load the manifest, which references devices only by path,
 * and use the manifest's directory as the base directory. `start` and `dev` run the rack with its
 * management endpoint, and shut down in order on `SIGINT`, `SIGTERM`, `SIGBREAK`, or
 * `rack ctl stop`, and with `--stop-on-stdin-close` when their standard input closes; `plan`
 * prints the plan without starting the rack; `compile` packages the rack into one executable.
 * `ctl` sends one operation to a running rack. `commands.ts` holds what an executable shares.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#commands-and-management
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-command
 * @decision .agents/decisions/261118_173838-running-under-another-program.md
 * @decision .agents/decisions/261120_011627-single-executables.md#compiling-a-rack
 */
import { dirname, relative, resolve } from "node:path";
import {
  describeError,
  fail,
  loadManifest,
  parseArgs,
  printPlan,
  runRack,
  sendOperation,
} from "./commands.ts";
import { compileRack } from "./compile.ts";

const USAGE = [
  "usage: rack <start|dev> [manifest path, default rack.ts] [--no-plan] [--no-watchdog]",
  "         [--control-port <port>] [--log text|json] [--stop-on-stdin-close]",
  "       rack plan [manifest path, default rack.ts] [--write | --check]",
  "       rack compile [manifest path, default rack.ts] [--outfile <file>] [--target <target>]",
  "       rack ctl status | metrics | reload | stop",
  "       rack ctl swap <device> [source] | restart <device> [--no-cascade]",
  "       rack ctl rollback <device> [--to <firmware>] | history [device]",
  "         [--dir <base directory>] [--url <url> --token <token>]",
].join("\n");

const FLAGS: Record<string, readonly string[]> = {
  start: ["--no-plan", "--no-watchdog", "--control-port", "--log", "--stop-on-stdin-close"],
  dev: ["--no-plan", "--no-watchdog", "--control-port", "--log", "--stop-on-stdin-close"],
  plan: ["--write", "--check"],
  compile: ["--outfile", "--target"],
  ctl: ["--dir", "--url", "--token", "--no-cascade", "--to"],
};

/** Flags that take a value, as `--flag value` or `--flag=value`. */
const VALUE_FLAGS = new Set([
  "--control-port",
  "--dir",
  "--url",
  "--token",
  "--to",
  "--log",
  "--outfile",
  "--target",
]);

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

/** Packages the rack into one executable, and prints what it packaged. */
async function compile(manifestPath: string, flags: ReadonlyMap<string, string>): Promise<void> {
  const manifest = await loadManifest(manifestPath);
  const outfile = flags.get("--outfile");
  const target = flags.get("--target");
  let result: Awaited<ReturnType<typeof compileRack>>;
  try {
    result = await compileRack(manifestPath, manifest, {
      ...(outfile === undefined ? {} : { outfile: resolve(outfile) }),
      ...(target === undefined ? {} : { target }),
    });
  } catch (error) {
    fail(describeError(error));
  }
  for (const device of result.devices) console.log(`packaged ${device.file} ${device.hash}`);
  const size = (result.size / 1024 / 1024).toFixed(1);
  console.log(`wrote ${relative(process.cwd(), result.outfile) || result.outfile}, ${size} MiB`);
}

async function main(args: string[]): Promise<void> {
  const [command = "", ...rest] = args;
  const { positional, flags } = parseArgs(rest, VALUE_FLAGS, usage);
  const known = FLAGS[command];
  if (known === undefined || [...flags.keys()].some((flag) => !known.includes(flag))) usage();
  if (command === "ctl") {
    await sendOperation(positional, flags, resolve(flags.get("--dir") ?? process.cwd()), usage);
    return;
  }
  if (positional.length > 1) usage();
  const manifestPath = resolve(positional[0] ?? "rack.ts");
  if (command === "plan") {
    await printPlan(manifestPath, flags);
    return;
  }
  if (command === "compile") {
    await compile(manifestPath, flags);
    return;
  }
  await runRack({
    command: command === "dev" ? "dev" : "start",
    manifest: () => loadManifest(manifestPath),
    baseDir: dirname(manifestPath),
    flags,
    usage,
    manifestPath,
  });
}

await main(process.argv.slice(2));
