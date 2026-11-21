/**
 * Tests of the README: its hot-reload example runs as written, and its image is the rendering of
 * its source, at the size that the render script gives it.
 *
 * @decision .agents/decisions/261121_044629-readme-at-a-glance.md#tests
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DENSITY,
  HASH_COMMENT,
  HEIGHT,
  IMAGE,
  sourceHash,
  WIDTH,
} from "../scripts/render-images.ts";
import { Cli, ROOT, type TempApp, tempApp, useControlDir } from "./fixtures/app.ts";

const README = await Bun.file(join(ROOT, "README.md")).text();

const apps: TempApp[] = [];
const processes: Cli[] = [];
useControlDir();

afterEach(async () => {
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** The README's `ts` code blocks, keyed by the path in their `// <path>` first line. */
function files(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, code = ""] of README.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const path = /^\/\/ ([\w./-]+\.ts)\n/.exec(code)?.[1];
    if (path === undefined) continue;
    if (result.has(path)) throw new Error(`${path} appears twice in the README`);
    result.set(path, code);
  }
  return result;
}

// @doc README.md#hot-reload-in-a-minute
describe("the README's hot-reload example", () => {
  test("answers Hello, and Hello again after the edit it describes, from the same rack", async () => {
    const example = files();
    expect([...example.keys()].sort()).toEqual(["hello/devices/hello.ts", "hello/rack.ts"]);
    const app = await tempApp();
    apps.push(app);
    for (const [path, code] of example) await app.write(path, code);
    const cli = new Cli(["dev", "hello/rack.ts"], app.dir, { PORT: "0" });
    processes.push(cli);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    expect(await (await fetch(url)).text()).toBe("Hello\n");

    // "Change `"Hello\n"` to `"Hello again\n"` in `hello/devices/hello.ts`, and save".
    const [, from = "", to = "", path = ""] =
      /Change `"([^`]+)"` to `"([^`]+)"` in `([^`]+)`/.exec(README) ?? [];
    expect([from, to, path]).toEqual(["Hello\\n", "Hello again\\n", "hello/devices/hello.ts"]);
    const source = await app.read(path);
    expect(source).toContain(`"${from}"`);
    await app.write(path, source.replace(`"${from}"`, `"${to}"`));
    await cli.waitFor(/\[rack\] info hello swapped/);
    expect(await (await fetch(url)).text()).toBe("Hello again\n");
    // The rack that answers started once: the edit swapped a device, and restarted nothing.
    expect(cli.output.match(/rack hello started/g)).toHaveLength(1);
    expect(cli.process.exitCode).toBeNull();
  }, 30_000);
});

// @doc README.md#rack42u
describe("the README's image", () => {
  test("is the rendering of docs/images/rack.html, at the size that render:images gives it", async () => {
    const tag = /<img src="docs\/images\/rack\.png"[^>]* alt="([^"]+)">/.exec(README);
    expect(tag).not.toBeNull();
    expect(tag?.[1]?.length).toBeGreaterThan(40);
    const png = new Uint8Array(await Bun.file(IMAGE).arrayBuffer());
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // The IHDR chunk comes first, with the width and the height as big-endian 32-bit integers.
    const header = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect([header.getUint32(0), header.getUint32(4)]).toEqual([WIDTH * DENSITY, HEIGHT * DENSITY]);
    // An edit of the source without a new rendering fails here: run `bun run render:images`.
    expect(HASH_COMMENT.exec(README)?.[1]).toBe(await sourceHash());
  });
});
