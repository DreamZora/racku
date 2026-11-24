/**
 * The command line of an executable that `rack compile` made. Without a command, it starts the
 * rack it packaged, as `rack start` starts a manifest, with the same flags, `--base-dir`, and
 * `--watch`, which also applies outside files as they change; with `ctl`, it operates the rack
 * that it runs for the same base directory, as `rack ctl` does.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md#running-an-executable
 * @decision .agents/decisions/261120_221450-watching-outside-files.md#on-command-or-as-files-change
 */
import { basename, dirname, resolve } from "node:path";
import { fail, parseArgs, runRack, sendOperation, setProgram } from "./commands.ts";
import { isDeviceFileOrJson } from "./dev.ts";
import { isRackManifest } from "./manifest.ts";
import { type PackagedTable, setPackaged } from "./packaged.ts";

const START_FLAGS = [
  "--base-dir",
  "--watch",
  "--no-plan",
  "--no-watchdog",
  "--control-port",
  "--log",
  "--stop-on-stdin-close",
];

const CTL_FLAGS = ["--base-dir", "--url", "--token-file", "--no-cascade", "--to", "--after"];

/** Flags that take a value, as `--flag value` or `--flag=value`. */
const VALUE_FLAGS = new Set([
  "--base-dir",
  "--control-port",
  "--log",
  "--url",
  "--token-file",
  "--to",
  "--after",
]);

/**
 * Runs the executable's command line. The executable's main module calls it, after the prelude
 * that `rack compile` writes installed the executable's `import.meta` paths.
 *
 * @param table What `rack compile` packaged.
 * @param loadManifest Loads the packaged manifest; called once the base directory is known, so
 *   that the manifest's `import.meta` paths name places under it.
 */
export async function runExecutable(
  table: PackagedTable,
  loadManifest: () => Promise<{ default?: unknown }>,
): Promise<void> {
  const name = basename(process.execPath).replace(/\.exe$/i, "");
  setProgram(name);
  const usage = (): never => {
    console.error(
      [
        `usage: ${name} [--base-dir <dir>] [--watch] [--no-plan] [--no-watchdog]`,
        "         [--control-port <port>] [--log text|json] [--stop-on-stdin-close]",
        `       ${name} ctl status | metrics | reload | stop`,
        `       ${name} ctl swap <device> [source] | restart <device> [--no-cascade]`,
        `       ${name} ctl rollback <device> [--to <firmware>] | history [device]`,
        `       ${name} ctl events [--after <seq>]`,
        "         [--base-dir <dir>] [--url <url> [--token-file <file>]]",
      ].join("\n"),
    );
    process.exit(2);
  };
  const { positional, flags } = parseArgs(process.argv.slice(2), VALUE_FLAGS, usage);
  const ctl = positional[0] === "ctl";
  const known = ctl ? CTL_FLAGS : START_FLAGS;
  if ([...flags.keys()].some((flag) => !known.includes(flag))) usage();
  if (!ctl && positional.length > 0) usage();
  // The base directory stands for the manifest's directory: by default, the executable's own.
  const baseDir = resolve(flags.get("--base-dir") ?? dirname(process.execPath));
  setPackaged(table, baseDir);
  if (ctl) {
    await sendOperation(positional.slice(1), flags, baseDir, usage);
    return;
  }
  await runRack({
    command: "start",
    manifest: async () => {
      const manifest = (await loadManifest()).default;
      if (!isRackManifest(manifest)) fail("the packaged manifest does not default-export a rack()");
      return manifest;
    },
    baseDir,
    flags,
    usage,
    // Outside files apply as they change, as well as on command: only device files and JSON
    // count, so the data that devices keep in the base directory starts no reloads.
    ...(flags.has("--watch") ? { watch: { counts: isDeviceFileOrJson } } : {}),
  });
}
