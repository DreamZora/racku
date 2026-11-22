/**
 * Tests for firmware builds.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rack, slot, start } from "racku";
import { bench } from "racku/bench";
import {
  buildFirmware,
  declaredDependencies,
  explainMissingPackage,
  importFirmware,
  retryMissedImports,
} from "../src/firmware.ts";
import {
  CONTROL_DIR,
  errorOf,
  FIXTURES,
  ROOT,
  type TempApp,
  tempApp,
  useControlDir,
} from "./fixtures/app.ts";

const WINDOWS = process.platform === "win32";

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

async function app(): Promise<TempApp> {
  const created = await tempApp(["connectors.ts", "devices"], FIXTURES);
  apps.push(created);
  return created;
}

describe("buildFirmware", () => {
  test("writes one hashed bundle per device into .rack/firmware", async () => {
    const { dir } = await app();
    const firmware = await buildFirmware(join(dir, "devices/counter.ts"), dir);
    expect(dirname(firmware.path)).toBe(join(dir, ".rack", "firmware"));
    expect(basename(firmware.path)).toBe(`counter-${firmware.hash}.js`);
    expect(firmware.url).toBe(Bun.pathToFileURL(firmware.path).href);
    expect(firmware.source).toBe(join(dir, "devices/counter.ts"));
  });

  test("builds the same source to the same path and hash", async () => {
    const { dir } = await app();
    const first = await buildFirmware(join(dir, "devices/counter.ts"), dir);
    const second = await buildFirmware(join(dir, "devices/counter.ts"), dir);
    expect(second).toEqual(first);
  });

  test("changes the hash when a bundled file changes", async () => {
    const created = await app();
    const source = join(created.dir, "devices/counter.ts");
    const before = await buildFirmware(source, created.dir);
    const connectors = await created.read("connectors.ts");
    await created.write(
      "connectors.ts",
      connectors.replace("inc: rpc(", "dec: rpc(v.undefined(), v.number()),\n  inc: rpc("),
    );
    const after = await buildFirmware(source, created.dir);
    expect(after.hash).not.toBe(before.hash);
  });

  test("keeps the framework and declared dependencies external", async () => {
    const { dir } = await app();
    const firmware = await buildFirmware(join(dir, "devices/counter.ts"), dir);
    const code = await Bun.file(firmware.path).text();
    expect(code).toMatch(/from\s*"racku"/);
    expect(code).toMatch(/from\s*"valibot"/);
    // Bundled framework code would carry the connector() implementation.
    expect(code).not.toContain("must look like");
  });

  test("bundles files reached through tsconfig path aliases", async () => {
    const created = await app();
    await created.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["./lib/*"] } } }),
    );
    await created.write("lib/greeting.ts", 'export const greeting = "first";\n');
    await created.write(
      "devices/greeter.ts",
      'import { device } from "racku";\nimport { greeting } from "@lib/greeting.ts";\nexport default device({ model: greeting });\n',
    );
    const source = join(created.dir, "devices/greeter.ts");
    const before = await buildFirmware(source, created.dir);
    expect(await Bun.file(before.path).text()).toContain('"first"');
    await created.write("lib/greeting.ts", 'export const greeting = "second";\n');
    const after = await buildFirmware(source, created.dir);
    expect(after.hash).not.toBe(before.hash);
  });

  test("resolves externals of a bundle through the app's node_modules", async () => {
    const created = await app();
    const firmware = await buildFirmware(join(created.dir, "devices/counter.ts"), created.dir);
    const module = (await import(firmware.url)) as { default: { model: string } };
    expect(module.default.model).toBe("counter");
    expect(firmware.path.startsWith(created.dir)).toBe(true);
    expect(ROOT).not.toBe(created.dir);
  });

  test("reports build errors with the device file", async () => {
    const created = await app();
    await created.write("devices/broken.ts", "export default device({ model: ;\n");
    const source = join(created.dir, "devices/broken.ts");
    await expect(buildFirmware(source, created.dir)).rejects.toThrow(
      `firmware build failed for ${source}`,
    );
  });
});

// @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
describe("what a build may read and write", () => {
  test("a device file whose imports include a macro fails to build, and the macro doesn't run", async () => {
    const created = await app();
    const ran = join(created.dir, "macro-ran");
    await created.write(
      "devices/_now.ts",
      `export function now() {\n  require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran");\n  return 1;\n}\n`,
    );
    await created.write(
      "devices/timed.ts",
      'import { device } from "racku";\nimport { now } from "./_now.ts" with { type: "macro" };\nexport default device({ model: "timed-" + now() });\n',
    );
    const source = join(created.dir, "devices/timed.ts");
    const failed = buildFirmware(source, created.dir);
    await expect(failed).rejects.toThrow(`firmware build failed for ${source}`);
    await expect(failed).rejects.toThrow("Macros are disabled");
    expect(existsSync(ran)).toBe(false);
  });

  test("a build reads no tsconfig.json and no package.json from above the app's directory", async () => {
    const outer = await app();
    // The app lies inside a directory that someone else can write, which has a tsconfig.json
    // whose paths would lead an import out of the app, and a package.json.
    await outer.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["./evil/*"] } } }),
    );
    await outer.write("evil/greeting.ts", 'export const greeting = "from above the app";\n');
    const inner = join(outer.dir, "inner");
    await outer.write(
      "inner/devices/greeter.ts",
      'import { device } from "racku";\nimport { greeting } from "@lib/greeting.ts";\nexport default device({ model: greeting });\n',
    );
    await expect(buildFirmware(join(inner, "devices/greeter.ts"), inner)).rejects.toThrow(
      'Could not resolve: "@lib/greeting.ts"',
    );
    expect(await declaredDependencies(join(inner, "devices"), inner)).toEqual([]);
    expect(await declaredDependencies(join(inner, "devices"))).toEqual(["racku", "valibot"]);
    // The app's own tsconfig.json still counts.
    await outer.write(
      "inner/tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["./lib/*"] } } }),
    );
    await outer.write("inner/lib/greeting.ts", 'export const greeting = "from the app";\n');
    const firmware = await buildFirmware(join(inner, "devices/greeter.ts"), inner);
    expect(await Bun.file(firmware.path).text()).toContain('"from the app"');
  });

  test.skipIf(WINDOWS)(
    ".rack/ is its user's alone, also when it existed with looser modes",
    async () => {
      const created = await app();
      await mkdir(join(created.dir, ".rack"), { mode: 0o755 });
      await chmod(join(created.dir, ".rack"), 0o755);
      await buildFirmware(join(created.dir, "devices/counter.ts"), created.dir);
      expect(((await stat(join(created.dir, ".rack"))).mode & 0o777).toString(8)).toBe("700");
    },
  );

  test("a build keeps every file it wrote, and doesn't write a bundle that is there again", async () => {
    const created = await app();
    await created.write("devices/blob.bin", "bytes the device reads");
    await created.write(
      "devices/filed.ts",
      'import { device } from "racku";\nimport blob from "./blob.bin" with { type: "file" };\nexport default device({ model: "filed " + blob });\n',
    );
    const source = join(created.dir, "devices/filed.ts");
    const first = await buildFirmware(source, created.dir);
    expect(first.files).toHaveLength(2);
    expect(first.files?.[0]).toBe(first.path);
    for (const file of first.files ?? []) {
      expect(dirname(file)).toBe(join(created.dir, ".rack", "firmware"));
      expect(existsSync(file)).toBe(true);
    }
    const before = await stat(first.path);
    const second = await buildFirmware(source, created.dir);
    expect(second).toEqual(first);
    const after = await stat(first.path);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    // The build's own directory beside .rack/firmware/ is gone.
    expect(
      await Array.fromAsync(
        new Bun.Glob("firmware-*").scan({ cwd: join(created.dir, ".rack"), onlyFiles: false }),
      ),
    ).toEqual([]);
  });
});

describe("firmware of earlier runs", () => {
  useControlDir();
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = CONTROL_DIR;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  });

  // @doc docs/reference/limits.md#supervision-and-history
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
  test("a rack that holds its management endpoint deletes at its start the firmware that nothing needs", async () => {
    const created = await app();
    const firmwareDir = join(created.dir, ".rack", "firmware");
    await mkdir(firmwareDir, { recursive: true });
    const old = join(firmwareDir, "gone-00000000.js");
    await Bun.write(old, "export default {};\n");
    const hour = Date.now() / 1000 - 3600;
    await utimes(old, hour, hour);
    // The build directory of a process that ended.
    const ended = Bun.spawn([process.execPath, "-e", ""]);
    await ended.exited;
    const leftover = join(created.dir, ".rack", `firmware-${ended.pid}-1`);
    await mkdir(leftover);
    const logs: { message: string; data?: unknown }[] = [];
    const running = await start(rack("sweep", { slots: { 1: slot("./devices/counter.ts") } }), {
      baseDir: created.dir,
      control: true,
      logger: (entry) => logs.push(entry),
    });
    try {
      expect(existsSync(old)).toBe(false);
      expect(existsSync(leftover)).toBe(false);
      const firmware = running.status()[0]?.firmware;
      expect(existsSync(join(firmwareDir, `counter-${firmware}.js`))).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          message: "firmware that nothing needs deleted",
          data: { files: 1 },
        }),
      );
    } finally {
      await running.stop();
    }
    // A rack without the endpoint can't know that it is alone, and deletes nothing at its start.
    await Bun.write(old, "export default {};\n");
    await utimes(old, hour, hour);
    const alone = await start(rack("sweep", { slots: { 1: slot("./devices/counter.ts") } }), {
      baseDir: created.dir,
      logger: () => {},
    });
    await alone.stop();
    expect(existsSync(old)).toBe(true);
  });
});

// @doc docs/reference/api.md#start
// @doc docs/guides/running.md#running-a-rack-from-code
// @doc docs/guides/testing.md#the-bench
describe("a base directory outside the app", () => {
  const counter = join(FIXTURES, "devices", "counter.ts");
  const outside: string[] = [];
  afterEach(async () => {
    await Promise.all(outside.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function outsideDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "racku-outside-"));
    outside.push(dir);
    return dir;
  }
  function expectExplained(error: { code: string; message: string }, baseDir: string): void {
    expect(error.code).toBe("RACK_MANIFEST");
    expect(error.message).toMatch(/Cannot find package '(racku|valibot)'/);
    expect(error.message).toContain(
      `so the base directory, ${baseDir}, must lie inside the app, below the node_modules`,
    );
  }

  test("fails to start a rack with RACK_MANIFEST, whose message says why", async () => {
    const baseDir = await outsideDir();
    const manifest = rack("outside", { slots: { 1: slot(counter) } });
    expectExplained(await errorOf(start(manifest, { baseDir, logger: () => {} })), baseDir);
  });

  test("fails to start a bench the same way", async () => {
    const baseDir = await outsideDir();
    expectExplained(await errorOf(bench(counter, { baseDir })), baseDir);
  });

  test("explains a missing package only when the device file finds it", () => {
    const firmware = {
      path: "/elsewhere/.rack/firmware/counter-0000.js",
      url: "file:///elsewhere/.rack/firmware/counter-0000.js",
      hash: "0000",
      source: counter,
    };
    const missing = (name: string) =>
      `Cannot find package '${name}' imported from /elsewhere/.rack/firmware/counter-0000.js`;
    expect(explainMissingPackage(missing("valibot"), firmware, "/elsewhere")).toContain(
      "below the node_modules that holds valibot",
    );
    expect(explainMissingPackage(missing("racku"), firmware, "/elsewhere")).toContain(
      "below the node_modules that holds racku",
    );
    // A package that the device file can't import either is missing from the app.
    expect(explainMissingPackage(missing("not-installed-anywhere"), firmware, "/elsewhere")).toBe(
      "",
    );
    expect(explainMissingPackage("boom", firmware, "/elsewhere")).toBe("");
  });
});

// Bun 1.4.4's bundler can miss a file written after its directory was cached, as import() can.
// @decision .agents/decisions/261119_031624-watching-bun-bugs.md
describe("retryMissedImports", () => {
  /** A device file that imports `./late.ts`, and a build of it into `.rack/firmware/`. */
  async function lateImport(dir: string) {
    const entry = join(dir, "devices", "late-entry.ts");
    await Bun.write(entry, 'import { late } from "./late.ts";\nexport default late;\n');
    return {
      late: join(dir, "devices", "late.ts"),
      build: () =>
        Bun.build({ entrypoints: [entry], outdir: join(dir, ".rack", "firmware"), target: "bun" }),
    };
  }

  test("builds again when Bun reports a relative import missing whose file is on disk", async () => {
    const { dir } = await app();
    const { late, build } = await lateImport(dir);
    let attempts = 0;
    const output = await retryMissedImports(async () => {
      attempts++;
      if (attempts > 1) return build();
      try {
        return await build();
      } finally {
        // The file is on disk once Bun's first lookup has missed it, as when two threads race.
        await Bun.write(late, "export const late = 42;\n");
      }
    });
    expect(output.success).toBe(true);
    expect(attempts).toBe(2);
  });

  // @doc docs/reference/limits.md#supervision-and-history
  test("gives up after four attempts", async () => {
    const { dir } = await app();
    const { late } = await lateImport(dir);
    await Bun.write(late, "export const late = 42;\n");
    const missed = new AggregateError(
      [
        {
          level: "error",
          code: "ERR_MODULE_NOT_FOUND",
          message: 'Could not resolve: "./late.ts"',
          specifier: "./late.ts",
          position: { file: join(dir, "devices", "late-entry.ts") },
        },
      ],
      "Bundle failed",
    );
    let attempts = 0;
    const error = await retryMissedImports(async () => {
      attempts++;
      throw missed;
    }).catch((caught: unknown) => caught);
    expect(error).toBe(missed);
    expect(attempts).toBe(4);
  });

  test("fails at once for an import not on disk, a package, and a syntax error", async () => {
    const { dir } = await app();
    const { build } = await lateImport(dir);
    const failures: [string, () => Promise<unknown>][] = [["a file not on disk", build]];
    const sources: [string, string][] = [
      ["a package", 'import "no-such-package-anywhere";\nexport default 1;\n'],
      ["a syntax error", "export default {{{\n"],
    ];
    for (const [what, source] of sources) {
      const entry = join(dir, "devices", `${what.replaceAll(" ", "-")}.ts`);
      await Bun.write(entry, source);
      failures.push([
        what,
        () => Bun.build({ entrypoints: [entry], outdir: join(dir, ".rack", "firmware") }),
      ]);
    }
    for (const [what, build] of failures) {
      let attempts = 0;
      const error = await retryMissedImports(() => {
        attempts++;
        return build();
      }).catch((caught: unknown) => caught);
      expect([what, error instanceof AggregateError, attempts]).toEqual([what, true, 1]);
    }
  });
});

describe("importFirmware", () => {
  test("imports a bundle again that Bun reports missing while it is on disk", async () => {
    const { dir } = await app();
    const path = join(dir, "late.js");
    const url = Bun.pathToFileURL(path).href;
    const attempts: string[] = [];
    const module = (await importFirmware(url, async (target) => {
      attempts.push(target);
      if (attempts.length > 1) return import(target);
      try {
        return await import(target);
      } finally {
        // The bundle is on disk once Bun's first lookup has missed it, as when Workers race.
        await Bun.write(path, "export default 42;\n");
      }
    })) as { default?: unknown };
    expect(module.default).toBe(42);
    expect(attempts).toEqual([url, url]);
  });

  // @doc docs/reference/limits.md#supervision-and-history
  test("gives up after four attempts", async () => {
    const { dir } = await app();
    const path = join(dir, "present.js");
    await Bun.write(path, "export default 1;\n");
    const missing = Object.assign(new Error(`Cannot find module '${path}'`), {
      code: "ERR_MODULE_NOT_FOUND",
      specifier: path,
    });
    let attempts = 0;
    const error = await importFirmware(Bun.pathToFileURL(path).href, async () => {
      attempts++;
      throw missing;
    }).catch((caught: unknown) => caught);
    expect(error).toBe(missing);
    expect(attempts).toBe(4);
  });

  test("fails at once for a bundle not on disk, one that throws, and one missing a module", async () => {
    const { dir } = await app();
    await Bun.write(join(dir, "throws.js"), 'throw new Error("broken at load");\n');
    await Bun.write(join(dir, "needs-absent.js"), 'import "racku-absent";\nexport default 1;\n');
    const cases = [
      ["absent.js", "Cannot find module"],
      ["throws.js", "broken at load"],
      ["needs-absent.js", "Cannot find package 'racku-absent'"],
    ] as const;
    for (const [file, message] of cases) {
      let attempts = 0;
      const error = await importFirmware(Bun.pathToFileURL(join(dir, file)).href, (target) => {
        attempts++;
        return import(target);
      }).catch((caught: unknown) => caught);
      expect(String((error as Error).message)).toContain(message);
      expect(attempts).toBe(1);
    }
  });

  test("imports the bundles that Workers write and import at the same time", async () => {
    // Bun 1.4.4 misses 10 to 20 of these imports on Linux, so without the further attempts this
    // test failed in every run. On Windows, it missed bundles of test racks in CI.
    const { dir } = await app();
    type Answer = { ok: boolean; value?: unknown; error?: string; attempts: number };
    const workers = Array.from({ length: 8 }, () => new Worker(join(FIXTURES, "import-worker.ts")));
    const ask = (worker: Worker, url: string) =>
      new Promise<Answer>((resolve) => {
        worker.addEventListener(
          "message",
          (event) => resolve((event as MessageEvent<Answer>).data),
          { once: true },
        );
        worker.postMessage(url);
      });
    try {
      const until = Date.now() + 2_000;
      for (let round = 0; Date.now() < until; round++) {
        const answers = await Promise.all(
          workers.map(async (worker, index) => {
            const path = join(dir, ".rack", "firmware", `w${index}-${round}.js`);
            await Bun.write(
              path,
              `import { device } from "racku";\nexport default typeof device === "function" ? ${round} : -1;\n`,
            );
            return ask(worker, Bun.pathToFileURL(path).href);
          }),
        );
        for (const answer of answers) {
          expect(answer).toEqual({ ok: true, value: round, attempts: answer.attempts });
        }
      }
    } finally {
      for (const worker of workers) worker.terminate();
    }
  }, 30_000);
});

// @doc docs/guides/devices.md#a-device-file
// @doc docs/concepts.md#firmware
// @decision .agents/decisions/261119_213017-firmware-import-meta.md#tests
describe("import.meta in firmware", () => {
  type Paths = { url: string; dir: string; dirname: string; path: string; filename: string };
  type Where = { device: Paths; helper: Paths; text: string };

  /** The paths as real paths, since a temporary directory can lie behind a symlink. */
  const real = ({ device, helper, text }: Where) => {
    const paths = (p: Paths) =>
      [fileURLToPath(p.url), p.dir, p.dirname, p.path, p.filename].map((path) =>
        realpathSync(path),
      );
    return { device: paths(device), helper: paths(helper), text };
  };
  /** What a file reports when its import.meta names it: its path, its directory twice, itself. */
  const of = (file: string) => {
    const path = realpathSync(file);
    return [path, dirname(path), dirname(path), path, path];
  };

  test("a device's firmware keeps the import.meta paths of its sources, on the bench, after a swap, and in a rack", async () => {
    const created = await app();
    const expected = {
      device: of(join(created.dir, "devices", "located.ts")),
      helper: of(join(created.dir, "devices", "_located", "where.ts")),
      text: "read next to the device's source\n",
    };
    {
      await using located = await bench("./devices/located.ts", { baseDir: created.dir });
      expect(real(await located.call<Where>("located", "where", undefined))).toEqual(expected);
      await located.swap();
      expect(real(await located.call<Where>("located", "where", undefined))).toEqual(expected);
    }
    const running = await start(rack("located", { slots: { 1: slot("./devices/located.ts") } }), {
      baseDir: created.dir,
      logger: () => {},
    });
    try {
      expect(real((await running.call("located.located", "where", undefined)) as Where)).toEqual(
        expected,
      );
    } finally {
      await running.stop();
    }
  });
});
