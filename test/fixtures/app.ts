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
