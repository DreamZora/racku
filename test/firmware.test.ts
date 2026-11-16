/**
 * Tests for firmware builds.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 */
import { afterEach, describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { buildFirmware } from "../src/firmware.ts";
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
