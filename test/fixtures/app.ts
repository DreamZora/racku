/**
 * Helpers for rack tests: fixture paths, temporary app directories, log capture, and waits.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#test-fixtures
 */
import { afterAll, afterEach, beforeAll } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LogEntry,
  RackError,
  type RackEvent,
  type RackHandle,
  type RackSpec,
  rack,
  type StartOptions,
  start,
} from "rack42u";

/** The repository root. */
export const ROOT = join(import.meta.dir, "..", "..");

/** This directory; use it as the base directory of racks that mount fixture devices. */
export const FIXTURES = import.meta.dir;

/**
 * Removes `.rack/` under {@link FIXTURES}, where racks on the fixture devices write their
 * firmware, after the tests of the file that calls it. Every build writes its bundle again, so
 * nothing there outlives its use. Call it at the top level of every test file that builds
 * firmware with {@link FIXTURES} as the base directory; {@link useRacks} calls it.
 */
export function useFixtureRackDir(): void {
  afterAll(() => rm(join(FIXTURES, ".rack"), { recursive: true, force: true }));
}

/** Whether the tests run on Windows, which lacks POSIX signals, FIFOs, and Unix sockets. */
export const WINDOWS = process.platform === "win32";

/**
 * Runs `rack` processes on Windows, where a test can stop one in order only through a console.
 *
 * @decision .agents/decisions/261118_015204-windows.md#changes-to-the-repository-and-the-tests
 */
const CONSOLE_HOST = join(import.meta.dir, "console-host.ts");

/**
 * Where {@link CONTROL_DIR} sits. Outside Windows it is `/tmp`: the temporary directory of macOS
 * is long enough to push a socket path past the 104-byte limit of its Unix sockets.
 */
const CONTROL_PARENT = WINDOWS ? tmpdir() : "/tmp";

/** The name of a test run's runtime directory, before the id of the run's process. */
const CONTROL_PREFIX = "rack42u-test-control-";

/**
 * The runtime directory of the `rack` processes that tests start, so their management sockets
 * and control files stay out of the user's own. {@link useControlDir} removes it.
 */
export const CONTROL_DIR = join(CONTROL_PARENT, `${CONTROL_PREFIX}${process.pid}`);

/** Whether the running test file called {@link useControlDir}. */
let controlDirInUse = false;

/**
 * Removes {@link CONTROL_DIR} after the tests of the file that calls it, so that the directory
 * doesn't outlive the file; the racks of a later file create it again. Call it at the top level of
 * every test file that runs `rack` processes or gives a rack a control endpoint: {@link Cli}
 * refuses to start a process in a file that didn't.
 */
export function useControlDir(): void {
  beforeAll(() => {
    controlDirInUse = true;
  });
  afterAll(async () => {
    controlDirInUse = false;
    await rm(CONTROL_DIR, { recursive: true, force: true });
  });
}

/**
 * Removes the runtime directories of earlier test runs whose process has ended, such as a run
 * stopped with Ctrl+C, which couldn't remove its own. A directory whose process still runs, or
 * belongs to another user, stays.
 */
function removeEndedRunsControlDirs(): void {
  let names: string[];
  try {
    names = readdirSync(CONTROL_PARENT);
  } catch {
    // A temporary directory that can't be read holds nothing this suite could remove either.
    return;
  }
  for (const name of names) {
    if (!name.startsWith(CONTROL_PREFIX)) continue;
    const pid = Number(name.slice(CONTROL_PREFIX.length));
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      try {
        rmSync(join(CONTROL_PARENT, name), { recursive: true, force: true });
      } catch {
        // Another user's run left it, and only that user may remove it.
      }
    }
  }
}
removeEndedRunsControlDirs();

/** A temporary app directory whose `node_modules` links to this repository. */
export interface TempApp {
  dir: string;
  /** Writes a file relative to the app directory. */
  write(path: string, content: string): Promise<void>;
  /** Reads a file relative to the app directory. */
  read(path: string): Promise<string>;
  remove(): Promise<void>;
}

/**
 * Creates an app directory outside the repository, so tests can edit its files freely.
 *
 * @param copy Paths relative to the repository root, copied into the app with the same layout
 *   relative to `from`.
 * @param from Directory that `copy` paths are relative to inside the app; defaults to the root.
 */
export async function tempApp(copy: string[] = [], from = ROOT): Promise<TempApp> {
  const dir = await mkdtemp(join(tmpdir(), "rack42u-test-"));
  await mkdir(join(dir, "node_modules", "@standard-schema"), { recursive: true });
  await symlink(ROOT, join(dir, "node_modules", "rack42u"), "dir");
  await symlink(join(ROOT, "node_modules", "valibot"), join(dir, "node_modules", "valibot"), "dir");
  await symlink(
    join(ROOT, "node_modules", "@standard-schema", "spec"),
    join(dir, "node_modules", "@standard-schema", "spec"),
    "dir",
  );
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "rack42u-test-app",
      private: true,
      type: "module",
      dependencies: { rack42u: "*", valibot: "*" },
    }),
  );
  for (const path of copy) {
    await cp(join(from, path), join(dir, path), { recursive: true });
  }
  return {
    dir,
    write: (path, content) => Bun.write(join(dir, path), content).then(() => undefined),
    read: (path) => Bun.file(join(dir, path)).text(),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Collects log entries and rack events for assertions. */
export class Recorder {
  readonly logs: LogEntry[] = [];
  readonly events: RackEvent[] = [];
  readonly logger = (entry: LogEntry) => {
    this.logs.push(entry);
  };

  /** Subscribes to a rack's events. */
  attach(running: RackHandle): this {
    running.subscribe((event) => {
      if (event.type !== "log") this.events.push(event);
    });
    return this;
  }

  /** The `hook` field of every `hook` log entry, as `<device>.<hook>`. */
  hooks(): string[] {
    return this.logs
      .filter((entry) => entry.message === "hook")
      .map((entry) => `${entry.device}.${(entry.data as { hook: string }).hook}`);
  }

  /** The URL from the last `listening` entry of an HTTP panel, by default `http-panel`. */
  panelUrl(device = "http-panel"): string {
    const entry = this.logs.findLast((e) => e.message === "listening" && e.device === device);
    if (entry === undefined) throw new Error(`${device} did not listen`);
    return (entry.data as { url: string }).url;
  }
}

/** A rack started by {@link useRacks}, with its recorder. */
export interface TestRack {
  running: RackHandle;
  rec: Recorder;
}

/**
 * Returns a function that starts racks on the fixture devices and stops them after each test.
 * Call it at the top level of a test file.
 */
export function useRacks(): (spec: RackSpec, options?: StartOptions) => Promise<TestRack> {
  const started: RackHandle[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((running) => running.stop()));
  });
  useFixtureRackDir();
  return async (spec, options = {}) => {
    const rec = new Recorder();
    const running = await start(rack("test", spec), {
      baseDir: FIXTURES,
      logger: rec.logger,
      ...options,
    });
    started.push(running);
    rec.attach(running);
    return { running, rec };
  };
}

/**
 * A `rack` command-line process with its combined output. On Windows, `rack start` and `rack dev`
 * run through `console-host.ts`, which turns {@link Cli.kill} into Ctrl+C or Ctrl+Break. Other
 * commands end by themselves, and run directly, which spares a process. A command with
 * `--stop-on-stdin-close` runs directly on every system, with its standard input a pipe that
 * {@link Cli.closeInput} closes.
 */
export class Cli {
  readonly process: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
  /** Standard output and standard error together, in the order they arrived. */
  output = "";
  /** Standard output alone. */
  stdout = "";
  readonly #hosted: boolean;

  /**
   * Runs `bun src/cli.ts <args>` with the Bun that runs the tests.
   *
   * @param args Command-line arguments, for example `["start", "rack.ts"]`.
   * @param cwd Working directory.
   * @param env Extra environment variables.
   * @param command Replaces the whole command line, for running the CLI another way.
   * @param input `"pipe"` runs the command directly with its standard input a pipe, as
   *   `--stop-on-stdin-close` does.
   */
  constructor(
    args: string[],
    cwd: string,
    env: Record<string, string> = {},
    command = [process.execPath, join(ROOT, "src", "cli.ts"), ...args],
    input?: "pipe",
  ) {
    if (!controlDirInUse) {
      throw new Error("call useControlDir() at the top level of this test file");
    }
    const piped = input === "pipe" || command.includes("--stop-on-stdin-close");
    this.#hosted = WINDOWS && !piped && (command.includes("start") || command.includes("dev"));
    this.process = Bun.spawn(
      this.#hosted ? [process.execPath, CONSOLE_HOST, ...command] : command,
      {
        cwd,
        env: { ...process.env, XDG_RUNTIME_DIR: CONTROL_DIR, ...env },
        stdin: this.#hosted || piped ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    void this.#pump(this.process.stdout, true);
    void this.#pump(this.process.stderr, false);
  }

  async #pump(stream: ReadableStream<Uint8Array>, stdout: boolean): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      this.output += text;
      if (stdout) this.stdout += text;
    }
  }

  /** Waits until the output matches `pattern`. */
  waitFor(pattern: RegExp, timeout = 15_000): Promise<RegExpMatchArray> {
    return waitFor(() => this.output.match(pattern) ?? undefined, timeout).catch(() => {
      throw new Error(`no output matching ${pattern} in:\n${this.output}`);
    });
  }

  /** Waits for the HTTP panel, `http-panel`, to listen, and returns its URL. */
  async panelUrl(): Promise<string> {
    const match = await this.waitFor(/\[http-panel\] info listening \{"url":"([^"]+)"\}/);
    return match[1] as string;
  }

  /** Resolves with the exit code once the process has exited and its output is read. */
  async exited(): Promise<number> {
    const code = await this.process.exited;
    await Bun.sleep(20);
    return code;
  }

  /**
   * Sends `signal`. On Windows, `SIGINT` arrives as Ctrl+C and `SIGBREAK` as Ctrl+Break, and any
   * other signal ends the process at once, since Windows has no others.
   */
  kill(signal: NodeJS.Signals = "SIGINT"): void {
    if (!this.#hosted) {
      this.process.kill(signal);
      return;
    }
    const stdin = this.process.stdin;
    if (typeof stdin !== "object" || stdin === null) return;
    try {
      stdin.write(`${signal}\n`);
      stdin.flush();
    } catch {
      // The console host has exited, and with it the command: there is nothing left to signal.
    }
  }

  /** Closes the standard input of a command run with `--stop-on-stdin-close`. */
  async closeInput(): Promise<void> {
    const stdin = this.process.stdin;
    if (typeof stdin === "object" && stdin !== null) await stdin.end();
  }

  /** Ends the process at once and waits until it has exited, so that its directory can go. */
  async stop(): Promise<void> {
    this.kill("SIGKILL");
    await this.process.exited;
  }
}

/** Polls `check` until it returns a value other than `undefined` or `false`. */
export async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeout = 5_000,
): Promise<T> {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

/** Returns the code of the `RackError` that `promise` rejects with. */
export async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RackError) return error.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Returns the `RackError` that `promise` rejects with. */
export async function errorOf(promise: Promise<unknown>): Promise<RackError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RackError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
