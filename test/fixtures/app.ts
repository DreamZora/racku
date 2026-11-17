/**
 * Helpers for rack tests: fixture paths, temporary app directories, log capture, and waits.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#test-fixtures
 */
import { afterEach } from "bun:test";
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
 * The runtime directory of the `rack` processes that tests start, so their management sockets
 * and control files stay out of the user's own. Outside Windows it sits in `/tmp`: the
 * temporary directory of macOS is long enough to push a socket path past the 104-byte limit of
 * its Unix sockets.
 */
export const CONTROL_DIR = join(
  process.platform === "win32" ? tmpdir() : "/tmp",
  `rack42u-test-control-${process.pid}`,
);

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

  /** The URL from the `panel http listening` entry. */
  panelUrl(): string {
    const entry = this.logs.find((e) => e.message === "panel http listening");
    if (entry === undefined) throw new Error("the panel did not open");
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

/** A `rack` command-line process with its combined output. */
export class Cli {
  readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output = "";

  /**
   * Runs `bun src/cli.ts <args>` with the Bun that runs the tests.
   *
   * @param args Command-line arguments, for example `["start", "rack.ts"]`.
   * @param cwd Working directory.
   * @param env Extra environment variables.
   * @param command Replaces the whole command line, for running the CLI another way.
   */
  constructor(
    args: string[],
    cwd: string,
    env: Record<string, string> = {},
    command = [process.execPath, join(ROOT, "src", "cli.ts"), ...args],
  ) {
    this.process = Bun.spawn(command, {
      cwd,
      env: { ...process.env, XDG_RUNTIME_DIR: CONTROL_DIR, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#pump(this.process.stdout);
    void this.#pump(this.process.stderr);
  }

  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.output += decoder.decode(chunk, { stream: true });
  }

  /** Waits until the output matches `pattern`. */
  waitFor(pattern: RegExp, timeout = 15_000): Promise<RegExpMatchArray> {
    return waitFor(() => this.output.match(pattern) ?? undefined, timeout).catch(() => {
      throw new Error(`no output matching ${pattern} in:\n${this.output}`);
    });
  }

  /** Waits for the panel and returns its URL. */
  async panelUrl(): Promise<string> {
    const match = await this.waitFor(/panel http listening \{"url":"([^"]+)"\}/);
    return match[1] as string;
  }

  /** Resolves with the exit code once the process has exited and its output is read. */
  async exited(): Promise<number> {
    const code = await this.process.exited;
    await Bun.sleep(20);
    return code;
  }

  kill(signal: NodeJS.Signals = "SIGINT"): void {
    this.process.kill(signal);
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
