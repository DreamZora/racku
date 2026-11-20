/**
 * Tests for firmware builds.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 */
import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rack, slot, start } from "rack42u";
import { bench } from "rack42u/bench";
import { buildFirmware, importFirmware } from "../src/firmware.ts";
import { FIXTURES, ROOT, type TempApp, tempApp } from "./fixtures/app.ts";

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
    expect(code).toMatch(/from\s*"rack42u"/);
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
      'import { device } from "rack42u";\nimport { greeting } from "@lib/greeting.ts";\nexport default device({ model: greeting });\n',
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
    await Bun.write(join(dir, "needs-absent.js"), 'import "rack42u-absent";\nexport default 1;\n');
    const cases = [
      ["absent.js", "Cannot find module"],
      ["throws.js", "broken at load"],
      ["needs-absent.js", "Cannot find package 'rack42u-absent'"],
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
              `import { device } from "rack42u";\nexport default typeof device === "function" ? ${round} : -1;\n`,
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
