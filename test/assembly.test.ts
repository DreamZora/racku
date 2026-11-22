/**
 * Tests for scanned racks: device files found in directories, planned into shared instances and
 * own copies, placed by the dependency graph and priorities, and recorded in a plan file.
 *
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#scanned-manifests
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#the-plan
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { rack, slot } from "racku";
import { memkv } from "racku/std";
import { planRack } from "../src/rack.ts";
import {
  Cli,
  codeOf,
  errorOf,
  type TempApp,
  tempApp,
  useControlDir,
  useRacks,
  waitFor,
} from "./fixtures/app.ts";

const startRack = useRacks();
useControlDir();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, rpc } from "racku";
import * as v from "valibot";

const counter = (id: string) => connector(id, { inc: rpc(v.undefined(), v.number()) });
export const D = counter("demo.d/v1");
export const E = counter("demo.e/v1");
export const F = counter("demo.f/v1");
export const Back = counter("demo.back/v1");
/** Increments through one of the device's needs, named by the input. */
export const Poke = connector("demo.poke/v1", { inc: rpc(v.string(), v.number()) });
`;

/** A device that counts the calls to the one port it provides. */
function counter(model: string, connector: string, extra = ""): string {
  return `import { device } from "racku";
import { Back, D, E, F } from "../connectors.ts";

let n = 0;

export default device({
  model: "${model}",${extra}
  provides: { ${model}: ${connector} },
  powerOn: () => ({ ${model}: { inc: () => ++n } }),
});
`;
}

/** A device whose \`poke.inc(need)\` increments through the named need. */
function consumer(model: string, needs: Record<string, string>, extra = ""): string {
  const list = Object.entries(needs)
    .map(([need, connector]) => `${need}: ${connector}`)
    .join(", ");
  return `import { device, own } from "racku";
import { Back, D, E, F, Poke } from "../connectors.ts";

export default device({
  model: "${model}",${extra}
  needs: { ${list} },
  provides: { poke: Poke },
  powerOn: (ctx) => ({ poke: { inc: (need) => ctx.ports[need].inc(undefined) } }),
});
`;
}

/** The user's example: A owns D and F, B shares E, C shares E and owns F. */
async function exampleApp(): Promise<TempApp> {
  const app = await tempApp();
  apps.push(app);
  await app.write("connectors.ts", CONNECTORS);
  await app.write("devices/a.ts", consumer("a", { d: "own(D)", f: "own(F)" }));
  await app.write("devices/b.ts", consumer("b", { e: "E" }));
  await app.write("devices/c.ts", consumer("c", { e: "E", f: "own(F)" }));
  await app.write("devices/d.ts", counter("d", "D"));
  await app.write("devices/e.ts", counter("e", "E"));
  await app.write("devices/f.ts", counter("f", "F"));
  await app.write(
    "rack.ts",
    `import { rack } from "racku";\n\nexport default rack("demo", { devices: ["./devices"], roots: ["a", "b", "c"] });\n`,
  );
  return app;
}

const SPEC = { devices: ["./devices"], roots: ["a", "b", "c"] };

const PLAN = `# racku plan of rack test: slot, instance, model, owner, and wiring.
# Written by \`rack dev\` and \`rack plan --write\`; do not edit by hand.
U1 a-d d a
U2 a-f f a
U3 c-f f c
U4 e e -
U5 a a - d=a-d.d f=a-f.f
U6 b b - e=e.e
U7 c c - e=e.e f=c-f.f
`;

describe("scanned racks", () => {
  // @doc docs/guides/racks.md#scanned-racks
  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("a scanned rack plans shared instances and own copies from its device files", async () => {
    const app = await exampleApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    expect(running.status().map((s) => [s.u, s.name, s.model, s.owner ?? null])).toEqual([
      [1, "a-d", "d", "a"],
      [2, "a-f", "f", "a"],
      [3, "c-f", "f", "c"],
      [4, "e", "e", null],
      [5, "a", "a", null],
      [6, "b", "b", null],
      [7, "c", "c", null],
    ]);
    const inc = (device: string, need: string) => running.call(`${device}.poke`, "inc", need);
    // Own copies count on their own; the shared e counts the calls of b and c together.
    expect([await inc("a", "f"), await inc("a", "f"), await inc("c", "f")]).toEqual([1, 2, 1]);
    expect([await inc("b", "e"), await inc("c", "e")]).toEqual([1, 2]);
  });

  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("a priority starts a device and what it needs earlier, within the dependency graph", async () => {
    const app = await exampleApp();
    await app.write("devices/c.ts", consumer("c", { e: "E", f: "own(F)" }, "\n  priority: 10,"));
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    expect(running.status().map((s) => s.name)).toEqual(["c-f", "e", "c", "a-d", "a-f", "a", "b"]);
  });

  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("a cycle fails with its path", async () => {
    const app = await exampleApp();
    await app.write(
      "devices/a.ts",
      consumer("a", { d: "own(D)", f: "own(F)" })
        .replace("provides: { poke: Poke },", "provides: { poke: Poke, back: Back },")
        .replace(
          "powerOn: (ctx) => ({ poke:",
          "powerOn: (ctx) => ({ back: { inc: () => 0 }, poke:",
        ),
    );
    await app.write(
      "devices/d.ts",
      counter("d", "D").replace("  provides:", "  needs: { back: Back },\n  provides:"),
    );
    const error = await errorOf(startRack(SPEC, { baseDir: app.dir }));
    expect([error.code, error.message]).toEqual(["RACK_MANIFEST", "cycle: a.d → a-d.back → a"]);
  });

  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("use picks the provider when several device files provide a connector", async () => {
    const app = await exampleApp();
    await app.write("devices/e2.ts", counter("e2", "E"));
    const ambiguous = await errorOf(startRack(SPEC, { baseDir: app.dir }));
    expect(ambiguous.message).toContain("b.e (demo.e/v1) is ambiguous: e, e2");
    const { running } = await startRack(
      { ...SPEC, use: { "demo.e/v1": "e2", "c.e": "e" } },
      { baseDir: app.dir, plan: false },
    );
    // b follows the connector-wide choice, e2; c follows its own entry, e. Separate counters prove it.
    const inc = (device: string) => running.call(`${device}.poke`, "inc", "e");
    expect([await inc("b"), await inc("c"), await inc("b")]).toEqual([1, 1, 2]);
    expect(await running.call("e2.e2", "inc", undefined)).toBe(3);
  });

  // @doc docs/guides/racks.md#scanned-racks
  test("devices takes standard devices and named variants next to directories", async () => {
    const app = await exampleApp();
    await app.write(
      "devices/k.ts",
      `import { device } from "racku";
import { Kv } from "racku/std";
import { Poke } from "../connectors.ts";

export default device({
  model: "k",
  needs: { cache: Kv },
  provides: { poke: Poke },
  powerOn: (ctx) => ({
    poke: {
      async inc(key) {
        const n = Number((await ctx.ports.cache.get(key)) ?? 0) + 1;
        await ctx.ports.cache.set({ key, value: String(n) });
        return n;
      },
    },
  }),
});
`,
    );
    const { running } = await startRack(
      { devices: ["./devices", memkv({ name: "cache" })], roots: ["k"] },
      { baseDir: app.dir },
    );
    expect(running.status().map((s) => [s.name, s.model])).toEqual([
      ["cache", "memkv"],
      ["k", "k"],
    ]);
    expect([
      await running.call("k.poke", "inc", "x"),
      await running.call("k.poke", "inc", "x"),
    ]).toEqual([1, 2]);
  });

  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("configuration comes from the instance name, then the model, then the spec in devices", async () => {
    const app = await tempApp();
    apps.push(app);
    await app.write(
      "devices/g.ts",
      `import { connector, device, rpc } from "racku";
import * as v from "valibot";

export const L = connector("demo.l/v1", { label: rpc(v.undefined(), v.string()) });

export default device({
  model: "g",
  config: v.object({ label: v.string() }),
  provides: { label: L },
  powerOn: (ctx) => ({ label: { label: () => ctx.config.label } }),
});
`,
    );
    for (const model of ["h", "i"]) {
      await app.write(
        `devices/${model}.ts`,
        `import { connector, device, own, rpc } from "racku";
import * as v from "valibot";
import { L } from "./g.ts";

const Ask = connector("demo.ask/v1", { label: rpc(v.undefined(), v.string()) });

export default device({
  model: "${model}",
  needs: { x: own(L) },
  provides: { ask: Ask },
  powerOn: (ctx) => ({ ask: { label: () => ctx.ports.x.label(undefined) } }),
});
`,
      );
    }
    const devices = ["./devices", slot("./devices/g.ts", { config: { label: "spec" } })];
    const labels = async (running: {
      call(a: string, m: string, i: unknown): Promise<unknown>;
    }) => [
      await running.call("h.ask", "label", undefined),
      await running.call("i.ask", "label", undefined),
    ];
    const first = await startRack(
      { devices, roots: ["h", "i"], config: { "h-x": { label: "instance" } } },
      { baseDir: app.dir, plan: false },
    );
    expect(await labels(first.running)).toEqual(["instance", "spec"]);
    await first.running.stop();
    const second = await startRack(
      {
        devices,
        roots: ["h", "i"],
        config: { "h-x": { label: "instance" }, g: { label: "model" } },
      },
      { baseDir: app.dir, plan: false },
    );
    expect(await labels(second.running)).toEqual(["instance", "model"]);
  });

  // @doc docs/guides/racks.md#scanned-racks
  test("a file in a scanned directory must be a device, unless its name starts with _", async () => {
    const app = await exampleApp();
    await app.write("devices/_helpers.ts", "export const helper = 1;\n");
    await app.write("devices/.draft.ts", "export const draft = 1;\n");
    await app.write("devices/_lib/util.ts", "export const util = 1;\n");
    await app.write("devices/node_modules/pkg/index.ts", "export const pkg = 1;\n");
    expect(
      (await startRack(SPEC, { baseDir: app.dir, plan: false })).running.status(),
    ).toHaveLength(7);
    await app.write("devices/helper.ts", "export const helper = 1;\n");
    const error = await errorOf(startRack(SPEC, { baseDir: app.dir, plan: false }));
    expect([error.code, error.message]).toEqual([
      "RACK_MANIFEST",
      expect.stringContaining("helper.ts does not default-export a device()"),
    ]);
  });

  // @doc docs/guides/racks.md#scanned-racks
  // @doc docs/guides/testing.md#the-bench
  // @doc docs/getting-started.md#test-a-device
  test("a test file in a scanned directory fails the start, as any file that isn't a device", async () => {
    const app = await exampleApp();
    await app.write(
      "devices/b.test.ts",
      'import { test } from "bun:test";\n\ntest("b", () => {});\n',
    );
    const error = await errorOf(startRack(SPEC, { baseDir: app.dir, plan: false }));
    expect([error.code, error.message]).toEqual([
      "RACK_MANIFEST",
      expect.stringContaining("b.test.ts"),
    ]);
  });

  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  // @doc docs/reference/api.md#the-rack-handle
  // @doc docs/guides/testing.md#swaps
  test("a scanned rack refuses plug, unplug, and swap from another file, and swaps from its own", async () => {
    const app = await exampleApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    expect(await codeOf(running.plug(20, slot("./devices/d.ts", { name: "extra" })))).toBe(
      "RACK_SWAP_REJECTED",
    );
    expect(await codeOf(running.unplug("b"))).toBe("RACK_SWAP_REJECTED");
    expect(await codeOf(running.swap("e", "./devices/f.ts"))).toBe("RACK_SWAP_REJECTED");
    await running.swap("e");
    expect(running.status().find((s) => s.name === "e")?.state).toBe("online");
  });
});

// @doc docs/guides/racks.md#the-plan-file
describe("the plan file", () => {
  test("the first start writes the plan file, and later starts follow it as written", async () => {
    const app = await exampleApp();
    const first = await startRack(SPEC, { baseDir: app.dir });
    expect(await app.read("test.plan")).toBe(PLAN);
    await first.running.stop();
    // Another valid order: c-f and c move up. The next start keeps it.
    await app.write("test.plan", PLAN.replace("U3 c-f", "U9 c-f").replace("U7 c c", "U10 c c"));
    const second = await startRack(SPEC, { baseDir: app.dir });
    expect(second.running.status().map((s) => `U${s.u} ${s.name}`)).toContain("U10 c");
  });

  test("rack start refuses a plan file that no longer fits, and rack dev rewrites it", async () => {
    const app = await exampleApp();
    await (await startRack(SPEC, { baseDir: app.dir })).running.stop();
    await app.write("devices/b.ts", consumer("b", { e: "E", d: "D" }));
    const stale = await errorOf(startRack(SPEC, { baseDir: app.dir }));
    expect([stale.code, stale.message]).toEqual([
      "RACK_MANIFEST",
      expect.stringContaining("test.plan no longer fits the devices: d is new"),
    ]);
    await startRack(SPEC, { baseDir: app.dir, plan: "update" });
    expect(await app.read("test.plan")).toContain(" b b - e=e.e d=d.d\n");
  });

  // @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
  test.skipIf(process.platform === "win32")(
    "the plan file is written whole, to a new file that is renamed into place",
    async () => {
      const app = await exampleApp();
      await (await startRack(SPEC, { baseDir: app.dir })).running.stop();
      const path = join(app.dir, "test.plan");
      const before = await stat(path);
      await app.write("devices/b.ts", consumer("b", { e: "E", d: "D" }));
      await (await startRack(SPEC, { baseDir: app.dir, plan: "update" })).running.stop();
      // A file renamed into place is a new file, where a file written in place keeps its inode.
      expect((await stat(path)).ino).not.toBe(before.ino);
      expect((await readdir(app.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  test("a rack run without a plan file neither reads nor writes one", async () => {
    const app = await exampleApp();
    await app.write("test.plan", "this line is not a plan\n");
    const { running } = await startRack(SPEC, { baseDir: app.dir, plan: false });
    expect(running.status()).toHaveLength(7);
    expect(await app.read("test.plan")).toBe("this line is not a plan\n");
  });

  test("a priority change alone keeps the plan file's order, and rack dev applies it", async () => {
    const app = await exampleApp();
    const following = await startRack(SPEC, { baseDir: app.dir });
    await app.write("devices/c.ts", consumer("c", { e: "E", f: "own(F)" }, "\n  priority: 10,"));
    await following.running.reload();
    expect(following.running.status().map((s) => s.name)).toEqual([
      "a-d",
      "a-f",
      "c-f",
      "e",
      "a",
      "b",
      "c",
    ]);
    await following.running.stop();
    const updating = await startRack(SPEC, { baseDir: app.dir, plan: "update" });
    expect(updating.running.status().map((s) => s.name)).toEqual([
      "c-f",
      "e",
      "c",
      "a-d",
      "a-f",
      "a",
      "b",
    ]);
    expect((await app.read("test.plan")).split("\n")[2]).toBe("U1 c-f f c");
  });

  test("under rack dev, a reload applies a priority change by moving instances to new slots", async () => {
    const app = await exampleApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir, plan: "update" });
    const before = (await running.call("c.poke", "inc", "e")) as number;
    await app.write("devices/c.ts", consumer("c", { e: "E", f: "own(F)" }, "\n  priority: 10,"));
    // c's file changed, so c is hot-swapped; every other instance only moves.
    const results = await running.reload();
    expect(results.map((result) => [result.device, result.error ?? null])).toEqual([["c", null]]);
    expect(running.status().map((s) => `U${s.u} ${s.name}`)).toEqual([
      "U1 c-f",
      "U2 e",
      "U3 c",
      "U4 a-d",
      "U5 a-f",
      "U6 a",
      "U7 b",
    ]);
    // Moving changes slot numbers only: the shared e kept running, and kept its count.
    expect(await running.call("c.poke", "inc", "e")).toBe(before + 1);
    expect((await app.read("test.plan")).split("\n")[2]).toBe("U1 c-f f c");
  });

  // @doc docs/reference/cli.md#flags-of-rack-plan
  test("rack plan prints the plan, --write writes the file, and --check fails until it fits", async () => {
    const app = await exampleApp();
    const printed = new Cli(["plan"], app.dir);
    expect(await printed.exited()).toBe(0);
    expect(printed.output).toContain("U7 c c - e=e.e f=c-f.f\n");
    expect(printed.output).toContain("demo.plan does not exist; --write creates it");
    const missing = new Cli(["plan", "--check"], app.dir);
    expect(await missing.exited()).toBe(1);
    const written = new Cli(["plan", "--write"], app.dir);
    expect(await written.exited()).toBe(0);
    expect(await app.read("demo.plan")).toContain("U1 a-d d a\n");
    const fits = new Cli(["plan", "--check"], app.dir);
    expect(await fits.exited()).toBe(0);
    await app.write("devices/b.ts", consumer("b", { e: "E", d: "D" }));
    const stale = new Cli(["plan", "--check"], app.dir);
    expect(await stale.exited()).toBe(1);
    expect(stale.output).toContain("#   d is new");
  });

  // @doc docs/reference/cli.md#flags-of-rack-plan
  test("rack plan takes --write or --check, not both, and neither for a rack placed by hand", async () => {
    const app = await exampleApp();
    const both = new Cli(["plan", "--write", "--check"], app.dir);
    expect(await both.exited()).toBe(1);
    expect(both.output).toContain("--write and --check exclude each other");
    await app.write(
      "placed.ts",
      `import { rack, slot } from "racku";\n\nexport default rack("placed", { slots: { 1: slot("./devices/d.ts") } });\n`,
    );
    const placed = new Cli(["plan", "placed.ts", "--write"], app.dir);
    expect(await placed.exited()).toBe(1);
    expect(placed.output).toContain("places devices by hand, so it has no plan file");
  });
});

describe("the rack command with scanned racks", () => {
  const running: Cli[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((cli) => cli.stop()));
  });

  // @doc docs/guides/racks.md#the-plan-file
  test("rack dev rewrites a plan file that no longer fits, and --no-plan ignores it", async () => {
    const app = await exampleApp();
    await app.write("demo.plan", "U1 ghost ghost -\n");
    const start = new Cli(["start", "--no-plan"], app.dir);
    running.push(start);
    await start.waitFor(/rack demo started/);
    expect(await app.read("demo.plan")).toBe("U1 ghost ghost -\n");
    start.kill("SIGINT");
    expect(await start.exited()).toBe(0);
    const refused = new Cli(["start"], app.dir);
    expect(await refused.exited()).toBe(1);
    expect(refused.output).toContain("demo.plan no longer fits the devices");
    const devWithout = new Cli(["dev", "--no-plan"], app.dir);
    running.push(devWithout);
    await devWithout.waitFor(/rack demo started/);
    expect(await app.read("demo.plan")).toBe("U1 ghost ghost -\n");
    devWithout.kill("SIGINT");
    expect(await devWithout.exited()).toBe(0);
    const dev = new Cli(["dev"], app.dir);
    running.push(dev);
    await dev.waitFor(/rack demo started/);
    expect(await app.read("demo.plan")).toContain("U1 a-d d a\n");
    dev.kill("SIGINT");
    expect(await dev.exited()).toBe(0);
    // Four rack processes, one after the other: on a Windows runner, more than Bun's default
    // of 5 s.
  }, 30_000);

  // @doc docs/guides/racks.md#the-plan-file
  test("rack dev writes the plan file when the plan changes, and leaves it as it is otherwise", async () => {
    const app = await exampleApp();
    const dev = new Cli(["dev"], app.dir);
    running.push(dev);
    await dev.waitFor(/watching /);
    const file = join(app.dir, "demo.plan");
    const plan = async () => [await app.read("demo.plan"), (await stat(file)).mtimeMs] as const;
    // Reloads run one at a time, and a reload writes the plan file, if at all, before it ends. So
    // once an edit of e has swapped e, every reload before it has ended.
    let edits = 0;
    const editE = async () => {
      edits += 1;
      await app.write("devices/e.ts", counter("e", "E").replace("let n = 0;", `let n = ${edits};`));
      const swaps = () => dev.output.match(/\[rack\] info e swapped/g)?.length ?? 0;
      await waitFor(() => swaps() >= edits, 15_000);
    };

    // The watcher counts every write as a change, so a write of the same plan would set off
    // another reload, and that one another write, without end.
    const started = await plan();
    await app.write("devices/d.ts", counter("d", "D").replace("let n = 0;", "let n = 100;"));
    await dev.waitFor(/\[rack\] info a-d swapped/);
    await editE();
    expect(await plan()).toEqual(started);

    // b needs D too: the plan gains a shared d, and the file the new plan.
    await app.write("devices/b.ts", consumer("b", { e: "E", d: "D" }));
    await dev.waitFor(/\[rack\] info b swapped/);
    await editE();
    const changed = await plan();
    expect(changed[0]).toMatch(/^U\d+ d d -$/m);
    expect(changed[0]).toMatch(/^U\d+ b b - .*\bd=d\.d\b/m);
    // The watcher saw that write too, and the reload it set off found the same plan.
    await editE();
    expect(await plan()).toEqual(changed);
    expect(dev.process.exitCode).toBeNull();
  }, 30_000);
});

describe("reloads of scanned racks", () => {
  // @doc docs/guides/updates.md#changed-plans-and-edited-manifests
  // @doc docs/guides/racks.md#the-plan-file
  test("under rack start, reload swaps changed files, and a new plan runs once the plan file records it", async () => {
    const app = await exampleApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    await app.write("devices/d.ts", counter("d", "D").replace("let n = 0;", "let n = 100;"));
    const results = await running.reload();
    expect(
      results.map((result) => [result.device, result.mode, result.error?.code ?? null]),
    ).toEqual([["a-d", "hot", null]]);
    expect(await running.call("a.poke", "inc", "d")).toBe(101);
    await app.write("devices/b.ts", consumer("b", { e: "E", d: "D" }));
    const stale = await errorOf(running.reload());
    expect([stale.code, stale.message]).toEqual([
      "RACK_SWAP_REJECTED",
      expect.stringContaining("test.plan no longer fits the devices: d is new"),
    ]);
    await planRack(rack("test", SPEC), { baseDir: app.dir }, true);
    const applied = await running.reload();
    expect(
      applied.map((result) => [result.device, result.mode, result.error?.code ?? null]),
    ).toEqual([
      ["d", "plug", null],
      ["b", "hot", null],
    ]);
    // b reached the new shared d, which counts from 100 like the edited file, apart from a's copy.
    const inc = (device: string) => running.call(`${device}.poke`, "inc", "d");
    expect([await inc("b"), await inc("b"), await inc("a")]).toEqual([101, 102, 102]);
  });
});

describe("own needs in a manifest that places devices by hand", () => {
  // @doc docs/guides/racks.md#shared-instances-and-own-copies
  test("an own need must not share its provider with another need", async () => {
    const app = await exampleApp();
    await app.write("devices/x.ts", consumer("x", { d: "own(D)" }));
    await app.write("devices/y.ts", consumer("y", { d: "D" }));
    const sharedOwn = await errorOf(
      startRack(
        {
          slots: {
            1: slot("./devices/d.ts"),
            2: slot("./devices/x.ts"),
            3: slot("./devices/y.ts"),
          },
        },
        { baseDir: app.dir },
      ),
    );
    expect([sharedOwn.code, sharedOwn.message]).toEqual([
      "RACK_MANIFEST",
      "x.d owns d, but y.d is wired to it too",
    ]);
    const { running } = await startRack(
      { slots: { 1: slot("./devices/d.ts"), 2: slot("./devices/x.ts") } },
      { baseDir: app.dir },
    );
    expect(running.status().map((s) => [s.name, s.owner ?? null])).toEqual([
      ["d", "x"],
      ["x", null],
    ]);
  });
});
