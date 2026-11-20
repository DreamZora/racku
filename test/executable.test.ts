/**
 * Tests for a rack in one executable: `rack compile` packages a small app, whose executable runs
 * its packaged devices, runs devices from files in its base directory instead, and falls back to
 * the packaged devices when those files fail.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md#tests
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotStatus, UpdateRecord } from "rack42u";
import { Cli, type TempApp, tempApp, useControlDir, WINDOWS, waitFor } from "./fixtures/app.ts";

useControlDir();

/**
 * The manifest: a name from the environment or from a file next to it, routes that it imports,
 * and so carries inside the executable, a database at a path relative to the base directory, and
 * two devices of the app, `store` below `hello`.
 */
const RACK = `import { rack, slot } from "rack42u";
import { httpPanel, sqlite } from "rack42u/std";
import routes from "./routes.json";

const named = await Bun.file(new URL("./name.txt", import.meta.url)).text().catch(() => "world");

export default rack("hello", {
  slots: {
    1: sqlite({ path: "data/hello.db" }),
    2: slot("./devices/store.ts"),
    3: slot("./devices/hello.ts", { config: { name: process.env.HELLO_NAME ?? named.trim() } }),
    4: httpPanel({ port: 0, routes }),
    // Mounted only when EXTRA is set, which it isn't when the rack is compiled.
    ...(process.env.EXTRA === undefined ? {} : { 5: slot("./devices/extra.ts") }),
  },
});
`;

/** The store: `kv/v1` in memory. */
function storeSource(more: { activate?: string } = {}): string {
  return `import { device } from "rack42u";
import { Kv } from "rack42u/std";

const values = new Map<string, string>();

export default device({
  model: "store",
  provides: { kv: Kv },
  powerOn: () => ({
    kv: {
      get: (key: string) => values.get(key) ?? null,
      set: ({ key, value }: { key: string; value: string }) => {
        values.set(key, value);
      },
      delete: (key: string) => values.delete(key),
      keys: (prefix: string) => [...values.keys()].filter((key) => key.startsWith(prefix)),
    },
  }),
  activate() {
    ${more.activate ?? ""}
  },
});
`;
}

/** What a copy of `hello` changes; tests put such copies in a base directory. */
interface HelloChanges {
  imports?: string;
  /** The device's other members, such as `selfTest`. */
  members?: string;
  activate?: string;
  /** An expression added to the greeting. */
  suffix?: string;
  config?: string;
  needs?: string;
}

/**
 * The device `hello`: it greets with a file next to its source, stores the greeting below, says
 * which copy answered, and fails with a code of its own on `/fail`.
 */
function helloSource(from: string, more: HelloChanges = {}): string {
  return `import { device, RackError } from "rack42u";
import { Http, httpHandler, Kv } from "rack42u/std";
import * as v from "valibot";
${more.imports ?? ""}
export default device({
  model: "hello",
  needs: { cache: Kv${more.needs ?? ""} },
  provides: { http: Http },
  config: ${more.config ?? "v.object({ name: v.string() })"},
  powerOn(ctx) {
    return {
      http: httpHandler(async (request) => {
        if (new URL(request.url).pathname === "/fail") {
          throw new RackError("HELLO_FAILED", "asked to fail");
        }
        const greeting = await Bun.file(new URL("./greeting.txt", import.meta.url))
          .text()
          .catch(() => "Hello");
        const text = \`\${greeting.trim()}, \${ctx.config.name}\${${more.suffix ?? '""'}}\`;
        await ctx.ports.cache.set({ key: "last", value: text });
        return Response.json({ text, from: ${JSON.stringify(from)} });
      }),
    };
  },
  ${more.members ?? ""}
  activate() {
    ${more.activate ?? ""}
  },
});
`;
}

let app: TempApp;
let exe: string;
/** The firmware hash that `rack compile` printed for each device file it packaged. */
const packagedHash = new Map<string, string>();
const bases: string[] = [];
const running: Cli[] = [];

beforeAll(async () => {
  app = await tempApp();
  await app.write("rack.ts", RACK);
  await app.write("routes.json", JSON.stringify({ "/*": "hello.http" }));
  await app.write("devices/store.ts", storeSource());
  await app.write("devices/hello.ts", helloSource("packaged"));
  const compile = new Cli(["compile", "rack.ts", "--outfile", join("dist", "hello")], app.dir);
  if ((await compile.exited()) !== 0) throw new Error(compile.output);
  exe = join(app.dir, "dist", WINDOWS ? "hello.exe" : "hello");
  for (const [, file = "", hash = ""] of compile.output.matchAll(/^packaged (\S+) (\S+)$/gm)) {
    packagedHash.set(file, hash);
  }
}, 120_000);

afterEach(async () => {
  await Promise.all(running.splice(0).map((cli) => cli.stop()));
  await Promise.all(bases.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await app?.remove();
});

/** A base directory for one run of the executable, with the files given. */
async function baseDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rack42u-test-base-"));
  bases.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  return dir;
}

/** Runs an executable for a base directory; its panel's URL once its rack started. */
async function run(
  dir: string,
  options: { env?: Record<string, string>; input?: "pipe" | "console"; flags?: string[] } = {},
  executable = exe,
): Promise<{ cli: Cli; url: string }> {
  const command = [executable, "--base-dir", dir, ...(options.flags ?? [])];
  const cli = new Cli([], dir, options.env ?? {}, command, options.input);
  running.push(cli);
  const url = await cli.panelUrl();
  await cli.waitFor(/control listening/);
  return { cli, url };
}

/**
 * Runs `<executable> ctl` for a base directory, and returns what it printed, parsed. Any
 * executable reaches the rack that runs for the directory.
 */
async function ctl<T>(dir: string, ...args: string[]): Promise<T> {
  const cli = new Cli([], dir, {}, [exe, "ctl", ...args, "--base-dir", dir]);
  const code = await cli.exited();
  await cli.ended;
  if (code !== 0) throw new Error(`ctl ${args.join(" ")} exited with ${code}: ${cli.output}`);
  return JSON.parse(cli.stdout) as T;
}

async function statusOf(dir: string, name: string): Promise<SlotStatus> {
  const found = (await ctl<SlotStatus[]>(dir, "status")).find((slot) => slot.name === name);
  if (found === undefined) throw new Error(`no device ${name}`);
  return found;
}

async function greet(url: string): Promise<{ text: string; from: string }> {
  return (await fetch(url).then((response) => response.json())) as { text: string; from: string };
}

// @doc docs/guides/running.md#a-rack-in-one-executable
// @doc docs/reference/cli.md#the-command-line-of-an-executable
// @doc docs/reference/reports.md#status
// @doc docs/reference/limits.md#executables
// @doc docs/guides/updates.md#fallback
describe("an executable from rack compile", () => {
  test("runs its packaged devices with the environment it starts in, under its base directory", async () => {
    const dir = await baseDir();
    // routes.json isn't in the base directory: the manifest imported it, so the executable has it.
    const { url } = await run(dir, { env: { HELLO_NAME: "Ada" } });
    expect(await greet(url)).toEqual({ text: "Hello, Ada", from: "packaged" });
    const devices = await ctl<SlotStatus[]>(dir, "status");
    expect(devices.map((slot) => [slot.name, slot.state, slot.packaged])).toEqual([
      ["sqlite", "online", true],
      ["store", "online", true],
      ["hello", "online", true],
      ["http-panel", "online", true],
    ]);
    // A device of the app names the place of its outside file.
    expect(devices[2]?.source).toBe(join(dir, "devices", "hello.ts"));
    // A path of a device's configuration is under the base directory; the rack wrote nothing.
    expect(existsSync(join(dir, "data", "hello.db"))).toBe(true);
    expect(existsSync(join(dir, ".rack"))).toBe(false);
  }, 30_000);

  test("gives the manifest and the devices files next to their sources from the base directory", async () => {
    const dir = await baseDir({ "name.txt": "Grace\n", "devices/greeting.txt": "Hi\n" });
    const { url } = await run(dir);
    expect(await greet(url)).toEqual({ text: "Hi, Grace", from: "packaged" });
  }, 30_000);

  test("runs a device file in the base directory in place of the packaged one, on probation", async () => {
    const dir = await baseDir({
      "devices/hello.ts": helloSource("outside", {
        imports: 'import { SUFFIX } from "./suffix.ts";',
        suffix: "SUFFIX",
      }),
      "devices/suffix.ts": 'export const SUFFIX = "!";\n',
    });
    const { cli, url } = await run(dir);
    // The file imports valibot, which the executable carries, rack42u from the Worker host, and
    // a file of its own, which its firmware bundles.
    expect(await greet(url)).toEqual({ text: "Hello, world!", from: "outside" });
    expect(cli.output).toContain(`hello runs ${join(dir, "devices", "hello.ts")}`);
    // The device's own RackError reaches the caller with its code.
    const failed = await fetch(new URL("/fail", url));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ code: "HELLO_FAILED", message: "asked to fail" });
    const hello = await statusOf(dir, "hello");
    expect(hello.state).toBe("online");
    expect(hello.packaged).toBeUndefined();
    expect(typeof hello.probationUntil).toBe("number");
    // Its packaged firmware is its known-good firmware.
    expect(hello.knownGood).toBe(packagedHash.get("devices/hello.ts") ?? "");
    expect(hello.knownGood).not.toBe(hello.firmware);
    expect(existsSync(join(dir, ".rack", "firmware", `hello-${hello.firmware}.js`))).toBe(true);
  }, 30_000);

  const failures: [string, HelloChanges, string][] = [
    ["fails to build", { imports: 'import "no-such-package-anywhere";' }, "RACK_SWAP_REJECTED"],
    ["fails to load", { imports: 'throw new Error("no load");' }, "RACK_MANIFEST"],
    ["fails to boot", { config: "v.object({ name: v.number() })" }, "RACK_INVALID_CONFIG"],
    [
      "fails to be wired",
      {
        imports: [
          'import { connector, rpc } from "rack42u";',
          'const Nothing = connector("nothing/v1", { get: rpc(v.string(), v.string()) });',
        ].join("\n"),
        needs: ", nothing: Nothing",
      },
      "RACK_MANIFEST",
    ],
    [
      "fails its self-test",
      { members: 'selfTest() { throw new Error("self-test failed"); },' },
      "RACK_HOOK_FAILED",
    ],
  ];
  test.each(failures)(
    "runs the packaged device when the file %s",
    async (_what, changes, code) => {
      const dir = await baseDir({ "devices/hello.ts": helloSource("outside", changes) });
      const { cli, url } = await run(dir);
      expect(await greet(url)).toEqual({ text: "Hello, world", from: "packaged" });
      expect(cli.output).toContain("hello runs its packaged firmware: ");
      const hello = await statusOf(dir, "hello");
      expect([hello.state, hello.packaged, hello.error?.code]).toEqual(["degraded", true, code]);
      const records = await ctl<UpdateRecord[]>(dir, "history", "hello");
      expect(records.map(({ mode, cause, to, ok }) => ({ mode, cause, to, ok }))).toEqual([
        { mode: "restart", cause: "fallback", to: hello.firmware, ok: true },
      ]);
      if (code === "RACK_SWAP_REJECTED") expect(records[0]?.from).toBeNull();
    },
    30_000,
  );

  test("falls back to the packaged device when the file's device crashes on probation", async () => {
    const dir = await baseDir({
      "devices/hello.ts": helloSource("outside", {
        activate: 'setTimeout(() => { throw new Error("outside crash"); }, 300);',
      }),
    });
    const { cli, url } = await run(dir);
    await cli.waitFor(/hello crashed on probation; falling back to its known-good firmware/);
    const hello = await waitFor(async () => {
      const slot = await statusOf(dir, "hello");
      return slot.packaged === true && slot.state === "degraded" && slot;
    }, 15_000);
    expect(hello.error?.message).toContain("outside crash");
    expect(await greet(url)).toEqual({ text: "Hello, world", from: "packaged" });
    const [record] = await ctl<UpdateRecord[]>(dir, "history", "hello");
    expect([record?.cause, record?.to]).toEqual(["fallback", hello.firmware]);
    expect(record?.from).not.toBe(hello.firmware);
  }, 30_000);

  test("falls back with the outside files wired to the one that crashes", async () => {
    const dir = await baseDir({
      "devices/store.ts": storeSource(),
      "devices/hello.ts": helloSource("outside", {
        activate: 'setTimeout(() => { throw new Error("outside crash"); }, 300);',
      }),
    });
    const { url } = await run(dir);
    await waitFor(async () => {
      const devices = await ctl<SlotStatus[]>(dir, "status");
      const both = devices.filter((slot) => slot.name === "store" || slot.name === "hello");
      return both.every((slot) => slot.packaged === true && slot.state !== "resetting");
    }, 15_000);
    expect(await greet(url)).toEqual({ text: "Hello, world", from: "packaged" });
    const records = await ctl<UpdateRecord[]>(dir, "history");
    const fallbacks = records.filter((record) => record.cause === "fallback");
    expect(fallbacks.map((record) => record.device).sort()).toEqual(["hello", "store"]);
  }, 30_000);

  test("takes up a file at swap(name), keeps what runs when one fails at reload, and goes back without it", async () => {
    const dir = await baseDir();
    const { url } = await run(dir);
    const file = join(dir, "devices", "hello.ts");
    await Bun.write(file, helloSource("outside"));
    await ctl(dir, "swap", "hello");
    expect((await greet(url)).from).toBe("outside");

    await Bun.write(file, helloSource("broken", { imports: 'import "no-such-package-anywhere";' }));
    const failed = await ctl<{ device: string; error?: { code: string } }[]>(dir, "reload");
    expect(failed.map((result) => [result.device, result.error?.code])).toEqual([
      ["hello", "RACK_SWAP_REJECTED"],
    ]);
    expect((await greet(url)).from).toBe("outside");

    await rm(file);
    const results = await ctl<{ device: string; error?: unknown }[]>(dir, "reload");
    expect(results.map((result) => [result.device, result.error])).toEqual([["hello", undefined]]);
    expect((await greet(url)).from).toBe("packaged");
    const hello = await statusOf(dir, "hello");
    expect([hello.state, hello.packaged]).toEqual(["online", true]);
  }, 30_000);

  test("fails to start when the manifest mounts a device it didn't package", async () => {
    const dir = await baseDir({ "devices/extra.ts": storeSource() });
    const cli = new Cli([], dir, { EXTRA: "1" }, [exe, "--base-dir", dir]);
    running.push(cli);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain(
      `RACK_MANIFEST: ${join(dir, "devices", "extra.ts")} is not packaged in this executable`,
    );
  }, 30_000);

  test("refuses to start for a base directory that a rack already runs for", async () => {
    const dir = await baseDir();
    await run(dir);
    const second = new Cli([], dir, {}, [exe, "--base-dir", dir]);
    running.push(second);
    expect(await second.exited()).toBe(1);
    expect(second.output).toMatch(/RACK_MANIFEST: another rack.* already answers/);
  }, 30_000);

  test("shuts down in order on ctl stop, a signal, and the end of standard input", async () => {
    const stopped = await baseDir();
    const one = await run(stopped);
    await ctl(stopped, "stop");
    expect(await one.cli.exited()).toBe(0);
    expect(one.cli.output).toContain("rack hello stopped");

    const signaled = await baseDir();
    const two = await run(signaled, { input: "console" });
    two.cli.kill("SIGINT");
    expect(await two.cli.exited()).toBe(0);
    expect(two.cli.output).toContain("rack hello stopped");

    const piped = await baseDir();
    const three = await run(piped, { input: "pipe", flags: ["--stop-on-stdin-close"] });
    await three.cli.closeInput();
    expect(await three.cli.exited()).toBe(0);
    expect(three.cli.output).toContain("rack hello stopped");
  }, 30_000);
});

// @doc docs/reference/cli.md#commands
// @doc docs/reference/cli.md#flags-of-rack-compile
describe("rack compile", () => {
  test("writes an executable for another system with --target", async () => {
    // Bun downloads the other system's runtime, once per machine.
    const [target, magic] = WINDOWS ? ["bun-linux-x64", "\x7fELF"] : ["bun-windows-x64", "MZ"];
    const outfile = join(app.dir, "dist", "other");
    const compile = new Cli(
      ["compile", "rack.ts", "--outfile", outfile, "--target", target],
      app.dir,
    );
    if ((await compile.exited()) !== 0) throw new Error(compile.output);
    const written = WINDOWS ? outfile : `${outfile}.exe`;
    const head = await Bun.file(written).slice(0, 4).text();
    expect(head.startsWith(magic)).toBe(true);
    expect(compile.output).toContain("packaged devices/hello.ts");
  }, 120_000);

  test("fails on a device that fails to build, and writes no executable", async () => {
    const broken = await tempApp();
    try {
      await broken.write("rack.ts", RACK);
      await broken.write("routes.json", "{}");
      await broken.write("devices/store.ts", storeSource());
      await broken.write("devices/hello.ts", "export default {{{ not a device\n");
      const compile = new Cli(["compile", "rack.ts", "--outfile", "hello"], broken.dir);
      expect(await compile.exited()).toBe(1);
      expect(compile.output).toContain("firmware build failed");
      expect(existsSync(join(broken.dir, WINDOWS ? "hello.exe" : "hello"))).toBe(false);
      expect(existsSync(join(broken.dir, ".rack", "compile"))).toBe(false);
    } finally {
      await broken.remove();
    }
  }, 120_000);

  test("packages a scanned rack, whose executable scans the device files it packaged", async () => {
    const scanned = await tempApp();
    try {
      await scanned.write(
        "rack.ts",
        `import { rack } from "rack42u";
import { httpPanel } from "rack42u/std";

export default rack("scanned", {
  devices: ["./devices", httpPanel({ port: 0, routes: { "/*": "hello.http" } })],
  roots: ["http-panel"],
  config: { hello: { name: "world" } },
});
`,
      );
      await scanned.write("devices/store.ts", storeSource());
      await scanned.write("devices/hello.ts", helloSource("packaged"));
      const compile = new Cli(["compile", "rack.ts", "--outfile", "scanned"], scanned.dir);
      if ((await compile.exited()) !== 0) throw new Error(compile.output);
      expect(compile.output).toContain("packaged devices/store.ts");
      // An outside file replaces a device that the executable scanned; another adds none.
      const dir = await baseDir({
        "devices/hello.ts": helloSource("outside"),
        "devices/extra.ts": storeSource().replace('model: "store"', 'model: "extra"'),
      });
      const executable = join(scanned.dir, WINDOWS ? "scanned.exe" : "scanned");
      const { url } = await run(dir, {}, executable);
      expect(await greet(url)).toEqual({ text: "Hello, world", from: "outside" });
      const devices = await ctl<SlotStatus[]>(dir, "status");
      expect(devices.map((slot) => slot.name).sort()).toEqual(["hello", "http-panel", "store"]);
      // The executable writes no plan file.
      expect(existsSync(join(dir, "scanned.plan"))).toBe(false);
    } finally {
      await scanned.remove();
    }
  }, 120_000);
});
