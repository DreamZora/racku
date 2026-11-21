/**
 * Packages the net tool's rack with `rack compile` into the sidecar that the installers carry:
 * `src-tauri/binaries/net-tool-rack-<target triple>`, with `.exe` on Windows, which is the name
 * that `externalBin` in `src-tauri/tauri.bundle.conf.json` asks for. `bun run sidecar` runs it,
 * and `bun run bundle` before it builds the installer.
 *
 * @decision .agents/decisions/261120_203926-net-tool-installers.md#the-sidecar
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const app = join(import.meta.dir, "..");
const repository = join(app, "..", "..", "..");

/** Runs a command to its end, with its output on this one's, and exits when it fails. */
function run(command: string[]): void {
  const done = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (done.exitCode !== 0) {
    console.error(`sidecar: ${command.join(" ")} exited with ${done.exitCode}`);
    process.exit(1);
  }
}

/** Runs a command to its end, and returns what it printed; exits when it fails. */
function read(command: string[]): string {
  const done = Bun.spawnSync(command, { stdout: "pipe", stderr: "inherit" });
  if (done.exitCode !== 0) {
    console.error(`sidecar: ${command.join(" ")} exited with ${done.exitCode}`);
    process.exit(1);
  }
  return done.stdout.toString().trim();
}

// The target triple of the shell that Cargo builds, which names the sidecar for tauri-build.
const triple = read(["rustc", "--print", "host-tuple"]);
const outfile = join(app, "src-tauri", "binaries", `net-tool-rack-${triple}`);
run([
  process.execPath,
  join(repository, "src", "cli.ts"),
  "compile",
  join(repository, "examples", "net-tool", "rack.ts"),
  "--outfile",
  outfile,
]);
// Bun adds .exe to an executable for Windows.
const written = process.platform === "win32" ? `${outfile}.exe` : outfile;
if (!existsSync(written)) {
  console.error(`sidecar: rack compile wrote no ${relative(app, written)}`);
  process.exit(1);
}
console.log(`sidecar: ${relative(app, written)}`);
