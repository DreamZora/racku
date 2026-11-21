/**
 * The installer workflow's smoke test, on the system that runs it. It installs the installer
 * that `bun run bundle` wrote, starts the installed app, replaces its `ui` device by hand and
 * then as the file changes, checks that a second copy of the app keeps its window with the
 * failure, and checks each time that the rack stops in order when the app is killed.
 *
 * Run it in `examples/net-tool/app` as `bun scripts/smoke.ts`, on Linux with a display, such as
 * under `xvfb-run -a`. With `--app <shell>`, it starts that executable of a release build
 * instead of installing one, such as `src-tauri/target/release/net-tool` after `bun run bundle`.
 * It needs an app without a `settings.json` and without replacements, and copies the app's logs
 * and what its shell printed to `src-tauri/target/smoke/`.
 *
 * @decision .agents/decisions/261120_203926-net-tool-installers.md#tests
 */
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ID = "dev.rack42u.net-tool";
const WINDOWS = process.platform === "win32";
const MACOS = process.platform === "darwin";
const EXE = WINDOWS ? ".exe" : "";

const app = join(import.meta.dir, "..");
const example = join(app, "..");
const bundles = join(app, "src-tauri", "target", "release", "bundle");
const logs = join(app, "src-tauri", "target", "smoke");

/** A device as `ctl status` reports it. */
interface Slot {
  name: string;
  state: string;
  firmware: string | null;
  source: string;
  packaged?: true;
  listeners: { webSockets: number }[];
  error?: { code: string; message: string };
}

/** What `ctl reload` did to one device. */
interface Reloaded {
  device: string;
  mode: string;
  error?: { code: string; message: string };
}

/** The app's directories, where its shell finds them with Tauri's path API. */
function places(): { base: string; settings: string; log: string } {
  const home = homedir();
  if (WINDOWS) {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return {
      base: join(local, ID, "rack"),
      settings: join(roaming, ID, "settings.json"),
      log: join(local, ID, "logs"),
    };
  }
  if (MACOS) {
    const support = join(home, "Library", "Application Support", ID);
    return {
      base: join(support, "rack"),
      settings: join(support, "settings.json"),
      log: join(home, "Library", "Logs", ID),
    };
  }
  const data = process.env.XDG_DATA_HOME?.startsWith("/")
    ? process.env.XDG_DATA_HOME
    : join(home, ".local", "share");
  const config = process.env.XDG_CONFIG_HOME?.startsWith("/")
    ? process.env.XDG_CONFIG_HOME
    : join(home, ".config");
  return {
    base: join(data, ID, "rack"),
    settings: join(config, ID, "settings.json"),
    log: join(data, ID, "logs"),
  };
}

const { base, settings, log } = places();
let step = "starting";

/** Fails the test at the step it reached. */
function fail(message: string): never {
  throw new Error(`${step}: ${message}`);
}

/** Polls `check` every 100 ms until it returns a value other than `undefined` or `false`. */
async function until<T>(
  what: string,
  seconds: number,
  check: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) fail(`${what}, not within ${seconds} s`);
    await Bun.sleep(100);
  }
}

/** Runs a command to its end, and fails when it fails. */
function run(command: string[]): void {
  const done = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (done.exitCode !== 0) fail(`${command.join(" ")} exited with ${done.exitCode}`);
}

/** The one file in `dir` whose name ends with `suffix`. */
async function only(dir: string, suffix: string): Promise<string> {
  const found = existsSync(dir) ? (await readdir(dir)).filter((name) => name.endsWith(suffix)) : [];
  if (found.length !== 1) fail(`expected one ${suffix} in ${dir}, found ${found.length}`);
  return join(dir, found[0] as string);
}

/** Installs the installer, and returns the installed shell and sidecar. */
async function install(): Promise<{ shell: string; sidecar: string }> {
  const given = process.argv.indexOf("--app");
  if (given !== -1) {
    const shell = resolve(process.argv[given + 1] ?? fail("--app needs the shell's path"));
    return { shell, sidecar: join(dirname(shell), `net-tool-rack${EXE}`) };
  }
  if (WINDOWS) {
    const setup = await only(join(bundles, "nsis"), "-setup.exe");
    const dir = join(await mkdtemp(join(tmpdir(), "net-tool-smoke-")), "net-tool");
    // NSIS takes the directory as the last argument, without quotes.
    run([setup, "/S", `/D=${dir}`]);
    return { shell: join(dir, "net-tool.exe"), sidecar: join(dir, "net-tool-rack.exe") };
  }
  if (MACOS) {
    const dmg = await only(join(bundles, "dmg"), ".dmg");
    const temp = await mkdtemp(join(tmpdir(), "net-tool-smoke-"));
    const mounted = join(temp, "dmg");
    run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mounted, dmg]);
    const applications = join(temp, "Applications");
    await mkdir(applications);
    run(["cp", "-R", join(mounted, "net-tool.app"), applications]);
    run(["hdiutil", "detach", mounted]);
    const macos = join(applications, "net-tool.app", "Contents", "MacOS");
    return { shell: join(macos, "net-tool"), sidecar: join(macos, "net-tool-rack") };
  }
  run(["sudo", "apt-get", "install", "-y", await only(join(bundles, "deb"), ".deb")]);
  return { shell: "/usr/bin/net-tool", sidecar: "/usr/bin/net-tool-rack" };
}

/** Runs the installed sidecar's `ctl <op>` for the app's base directory. */
function ctl(sidecar: string, op: string): { ok: boolean; stdout: string; stderr: string } {
  const done = Bun.spawnSync([sidecar, "ctl", op, "--base-dir", base], {
    cwd: base,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return {
    ok: done.exitCode === 0,
    stdout: done.stdout.toString(),
    stderr: done.stderr.toString(),
  };
}

function status(sidecar: string): Slot[] {
  const done = ctl(sidecar, "status");
  if (!done.ok) fail(`ctl status failed: ${done.stderr.trim()}`);
  return JSON.parse(done.stdout) as Slot[];
}

/** What `ctl status` reports of a device, or `undefined` while no rack answers. */
function tryStatus(sidecar: string, name: string): Slot | undefined {
  const done = ctl(sidecar, "status");
  if (!done.ok) return undefined;
  return (JSON.parse(done.stdout) as Slot[]).find((found) => found.name === name);
}

function slot(sidecar: string, name: string): Slot {
  return status(sidecar).find((found) => found.name === name) ?? fail(`no device ${name}`);
}

/** The log lines of this run: the JSON entries of `rack.log`, from `since` on. */
function entries(since: number): { time: number; device?: string; message: string }[] {
  const path = join(log, "rack.log");
  if (!existsSync(path)) return [];
  const found = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as { time: number; device?: string; message: string };
      if (entry.time >= since) found.push(entry);
    } catch {
      // A line of text, such as one of the shell's own.
    }
  }
  return found;
}

/** A running app, with what its shell printed. */
interface Running {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: string[];
  ended: Promise<void>;
}

/** Starts the installed app, and keeps what its shell prints. */
function spawn(shell: string): Running {
  const started = Bun.spawn([shell], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.push(decoder.decode(chunk, { stream: true }));
  };
  const running = {
    process: started,
    output,
    ended: Promise.all([pump(started.stdout), pump(started.stderr)]).then(() => undefined),
  };
  apps.push(running);
  return running;
}

/** Starts the installed app, and waits for its rack's panel and for the window's WebSocket. */
async function launch(shell: string, sidecar: string): Promise<Running> {
  const since = Date.now();
  const running = spawn(shell);
  const started = running.process;
  // The rack's control endpoint listens last, after the panel, as the start's last step.
  await until("the rack's start, with its panel and its control endpoint, in rack.log", 60, () => {
    const seen = entries(since);
    const panel = seen.some(
      (entry) => entry.device === "http-panel" && entry.message === "listening",
    );
    return panel && seen.some((entry) => entry.message === "control listening");
  });
  await until("the window's WebSocket on the panel", 60, () => {
    if (started.exitCode !== null) fail(`the app exited with ${started.exitCode}`);
    return (tryStatus(sidecar, "http-panel")?.listeners[0]?.webSockets ?? 0) > 0;
  });
  return running;
}

/** Kills the app, and waits until its rack has stopped in order and its process has ended. */
async function kill(running: Running, sidecar: string): Promise<void> {
  running.process.kill(9);
  await running.process.exited;
  await until("the rack stopping in order", 20, () => {
    const done = ctl(sidecar, "status");
    // A rack that was killed would leave its control endpoint behind: "cannot reach the rack".
    return !done.ok && done.stderr.includes("no running rack has the base directory");
  });
  await until("the sidecar's process ending", 20, () => !sidecarRuns());
}

/** Whether a process of the sidecar runs. */
function sidecarRuns(): boolean {
  if (WINDOWS) {
    const done = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq net-tool-rack.exe", "/NH"]);
    return done.stdout.toString().includes("net-tool-rack.exe");
  }
  return Bun.spawnSync(["pgrep", "-x", "net-tool-rack"]).exitCode === 0;
}

/** Copies the app's logs as they are now to `src-tauri/target/smoke/<name>/`. */
async function saveLogs(name: string): Promise<void> {
  await mkdir(join(logs, name), { recursive: true });
  for (const file of ["rack.log", "rack.old.log"]) {
    if (existsSync(join(log, file))) await cp(join(log, file), join(logs, name, file));
  }
}

/** The example's `ui`, with a line that gives each copy firmware of its own. */
function uiSource(copy: number): string {
  const source = readFileSync(join(example, "devices", "ui.ts"), "utf8");
  return `${source}\nexport const smokeCopy = ${copy};\n`;
}

const apps: Running[] = [];

async function smoke(): Promise<void> {
  if (existsSync(settings) || existsSync(join(base, "devices"))) {
    fail(`the app has a settings.json or replacements already: ${settings}, ${base}`);
  }
  step = "installing";
  const { shell, sidecar } = await install();
  for (const file of [shell, sidecar]) if (!existsSync(file)) fail(`${file} is missing`);

  step = "the first start, without settings.json";
  const first = await launch(shell, sidecar);
  if (slot(sidecar, "ui").packaged !== true) fail("ui doesn't run its packaged firmware");
  if (entries(0).some((entry) => entry.message.startsWith("watching"))) {
    fail("the rack watches its base directory, without the setting automatic");
  }

  step = "replacing ui by hand";
  await mkdir(join(base, "devices"), { recursive: true });
  await writeFile(join(base, "connectors.ts"), readFileSync(join(example, "connectors.ts")));
  await writeFile(join(base, "devices", "ui.ts"), uiSource(1));
  await Bun.sleep(2_000);
  if (slot(sidecar, "ui").packaged !== true) fail("ui took up its file without ctl reload");
  const reload = ctl(sidecar, "reload");
  if (!reload.ok) fail(`ctl reload failed: ${reload.stderr.trim()}`);
  const results = JSON.parse(reload.stdout) as Reloaded[];
  const replaced = results.find((result) => result.device === "ui");
  if (replaced === undefined || replaced.error !== undefined) {
    fail(`ctl reload didn't replace ui: ${reload.stdout}`);
  }
  const ui = slot(sidecar, "ui");
  if (ui.packaged === true || ui.source !== join(base, "devices", "ui.ts")) {
    fail(`ui doesn't run its file: ${JSON.stringify(ui)}`);
  }
  const panel = slot(sidecar, "http-panel");
  if ((panel.listeners[0]?.webSockets ?? 0) === 0) fail("the window's WebSocket closed");

  step = "killing the first app";
  await kill(first, sidecar);
  await saveLogs("first");

  step = "the second start, with automatic in settings.json";
  await mkdir(dirname(settings), { recursive: true });
  await writeFile(settings, `${JSON.stringify({ replaceDevices: "automatic" })}\n`);
  const since = Date.now();
  const second = await launch(shell, sidecar);
  if (!existsSync(join(log, "rack.old.log"))) fail("the first run's log isn't rack.old.log");
  if (!entries(since).some((entry) => entry.message.startsWith("watching"))) {
    fail("the rack doesn't watch its base directory");
  }
  const before = slot(sidecar, "ui");
  if (before.packaged === true) fail("ui doesn't run its file from the first run");

  step = "editing ui's file";
  await writeFile(join(base, "devices", "ui.ts"), uiSource(2));
  await until("ui running the edited file, without ctl reload", 10, () => {
    const now = tryStatus(sidecar, "ui");
    return now?.firmware !== before.firmware && now?.packaged !== true && now?.state === "online";
  });

  step = "starting a second copy of the app";
  const copy = spawn(shell);
  const failure = await until("the second copy's failure, in rack.log", 60, () => {
    const path = join(log, "rack.log");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    return text.split("\n").find((line) => line.includes("The rack couldn't start"));
  });
  if (!failure.includes("another rack")) fail(`another failure: ${failure}`);
  await Bun.sleep(2_000);
  if (copy.process.exitCode !== null) fail("the second copy exited, without its window");
  if (slot(sidecar, "ui").state !== "online") fail("the first copy's rack doesn't run on");
  copy.process.kill(9);
  await copy.process.exited;

  step = "killing the second app";
  await kill(second, sidecar);
  await saveLogs("second");
}

try {
  await smoke();
  console.log("smoke: passed");
} catch (error) {
  console.error(`smoke: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  for (const running of apps) running.process.kill(9);
} finally {
  await saveLogs("last");
  for (const [index, running] of apps.entries()) {
    await Promise.race([running.ended, Bun.sleep(5_000)]);
    await writeFile(join(logs, `shell-${index + 1}.log`), running.output.join(""));
  }
  console.log(`smoke: the logs are in ${logs}`);
}
