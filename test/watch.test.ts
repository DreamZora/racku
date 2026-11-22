/**
 * Tests for the watcher that `rack dev` and an executable with `--watch` share: when a reload
 * starts, how many run, and a watch that can't start. A stub stands in for the rack, so the tests
 * see each reload that the watcher asks for.
 *
 * @decision .agents/decisions/261120_221450-watching-outside-files.md#tests
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { LogEntry } from "racku";
import { DEBOUNCE_MS, isDeviceFileOrJson, MAX_WAIT_MS, watchAndReload } from "../src/dev.ts";
import { WINDOWS, waitFor } from "./fixtures/app.ts";

/** A rack that records when each reload starts, and holds them while `hold` is set. */
class StubRack {
  /** When each reload started, by `performance.now()`. */
  readonly starts: number[] = [];
  /** The most reloads that ran at once. */
  most = 0;
  hold = false;
  #running = 0;
  #held: (() => void)[] = [];

  readonly reload = async () => {
    this.starts.push(performance.now());
    this.#running++;
    this.most = Math.max(this.most, this.#running);
    if (this.hold) await new Promise<void>((resolve) => this.#held.push(resolve));
    this.#running--;
    return [];
  };

  /** Lets the reloads that wait end. */
  release(): void {
    for (const resolve of this.#held.splice(0)) resolve();
  }
}

const dirs: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function watched(
  rack: StubRack,
  counts?: (path: string) => boolean,
): Promise<{ dir: string; logs: LogEntry[] }> {
  const dir = await mkdtemp(join(tmpdir(), "racku-test-watch-"));
  dirs.push(dir);
  const logs: LogEntry[] = [];
  stops.push(
    watchAndReload(rack, {
      baseDir: dir,
      log: (entry) => logs.push(entry),
      ...(counts === undefined ? {} : { counts }),
    }),
  );
  return { dir, logs };
}

// @doc docs/reference/limits.md#watching
// @doc docs/guides/running.md#hot-reload-with-rack-dev
describe("watchAndReload", () => {
  test("starts a reload within about 1 s of the first change, when changes never pause", async () => {
    const rack = new StubRack();
    const { dir } = await watched(rack);
    const first = performance.now();
    // A change every 50 ms, which is less than the 100 ms of quiet that a reload waits for.
    for (let n = 0; rack.starts.length === 0 && performance.now() - first < 5_000; n++) {
      await Bun.write(join(dir, "device.ts"), `export const n = ${n};\n`);
      await Bun.sleep(50);
    }
    expect(DEBOUNCE_MS).toBe(100);
    expect(MAX_WAIT_MS).toBe(1_000);
    expect((rack.starts[0] ?? Number.POSITIVE_INFINITY) - first).toBeLessThan(1_500);
  }, 10_000);

  test("runs one reload at a time, and changes during one start one more after it", async () => {
    const rack = new StubRack();
    rack.hold = true;
    const { dir } = await watched(rack);
    await Bun.write(join(dir, "a.ts"), "export {};\n");
    await waitFor(() => rack.starts.length === 1);
    // Each change's wait ends while the reload runs.
    for (const name of ["b.ts", "c.ts", "d.ts"]) {
      await Bun.write(join(dir, name), "export {};\n");
      await Bun.sleep(150);
    }
    expect(rack.starts.length).toBe(1);
    rack.release();
    await waitFor(() => rack.starts.length === 2);
    rack.release();
    await Bun.sleep(500);
    expect(rack.starts.length).toBe(2);
    expect(rack.most).toBe(1);
  }, 10_000);

  test("counts only the changes that its filter counts", async () => {
    const rack = new StubRack();
    const { dir } = await watched(rack, isDeviceFileOrJson);
    await Bun.write(join(dir, "notes.txt"), "x");
    await Bun.write(join(dir, "data", "app.db"), "x");
    await Bun.sleep(500);
    expect(rack.starts.length).toBe(0);
    await Bun.write(join(dir, "data", "settings.json"), "{}");
    await waitFor(() => rack.starts.length === 1);
  }, 10_000);

  // Bun 1.4.4 on macOS reports a watched directory's own removal only to its parent's watch.
  // @decision .agents/decisions/261121_034144-watching-the-parent-directory.md
  test.each(["removed", "renamed away"])(
    "stops watching when its base directory is %s",
    async (what) => {
      const rack = new StubRack();
      const { dir, logs } = await watched(rack);
      if (what === "removed") await rm(dir, { recursive: true });
      else await rename(dir, `${dir}-moved`);
      dirs.push(`${dir}-moved`);
      const stopped = await waitFor(() =>
        logs.find((entry) => entry.message.startsWith("stopped watching")),
      );
      expect([stopped.level, stopped.message]).toEqual([
        "error",
        `stopped watching ${dir}${sep}: it was removed`,
      ]);
    },
    10_000,
  );

  // @decision .agents/decisions/261121_034144-watching-the-parent-directory.md
  test.skipIf(WINDOWS)(
    "warns when the base directory's parent can't be read, and watches the base directory anyway",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "racku-test-watch-parent-"));
      dirs.push(parent);
      const dir = join(parent, "base");
      await mkdir(dir);
      // The parent can be passed through to the base directory, but not read.
      await chmod(parent, 0o311);
      const rack = new StubRack();
      const logs: LogEntry[] = [];
      try {
        stops.push(watchAndReload(rack, { baseDir: dir, log: (entry) => logs.push(entry) }));
        expect(logs.map((entry) => entry.level)).toEqual(["warn", "info"]);
        expect(logs[0]?.message).toStartWith(`cannot watch ${parent}${sep} for the removal of`);
        await Bun.write(join(dir, "device.ts"), "export {};\n");
        await waitFor(() => rack.starts.length === 1);
      } finally {
        await chmod(parent, 0o755);
      }
    },
    10_000,
  );

  test("logs a watch that can't start, and stops nothing", async () => {
    const rack = new StubRack();
    const logs: LogEntry[] = [];
    const missing = join(tmpdir(), `racku-test-watch-missing-${process.pid}`);
    const stop = watchAndReload(rack, { baseDir: missing, log: (entry) => logs.push(entry) });
    expect(logs.map((entry) => entry.level)).toEqual(["error"]);
    expect(logs[0]?.message).toStartWith(`cannot watch ${missing}`);
    expect(logs[0]?.message).toContain("ENOENT");
    stop();
  });
});
