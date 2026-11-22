/**
 * Tests of hot-plug directories: devices that start without roots, below the host whose every
 * need reaches them, come and go with their files, and are left out when they can't run, while
 * the rest of the rack starts and reloads.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#hot-plug-directories
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#where-hot-plug-devices-go
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#the-plan-file
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#failures
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { rack } from "rack42u";
import { compileRack } from "../src/compile.ts";
import { planRack, reloadHotplug } from "../src/rack.ts";
import { Cli, errorOf, type TempApp, tempApp, useControlDir, useRacks } from "./fixtures/app.ts";
import { CONNECTORS, HOST, host, tool } from "./fixtures/tools.ts";

const startRack = useRacks();
useControlDir();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const SPEC = { devices: ["./devices"], hotplug: ["./plugins"], roots: ["host"] };

/** An app whose host is a fixed device, with upper and lower in its hot-plug directory. */
async function hotplugApp(): Promise<TempApp> {
  const app = await tempApp();
  apps.push(app);
  await app.write("connectors.ts", CONNECTORS);
  await app.write("devices/host.ts", HOST);
  await app.write("plugins/upper.ts", tool("upper", "text.toUpperCase()"));
  await app.write("plugins/lower.ts", tool("lower", "text.toLowerCase()"));
  return app;
}

const names = (running: { status(): { name: string }[] }) => running.status().map((s) => s.name);

describe("hot-plug directories", () => {
  test("their devices start without roots, below the host that reaches them, and the plan file records the fixed instances alone", async () => {
    const app = await hotplugApp();
    const { running, rec } = await startRack(SPEC, { baseDir: app.dir });
    expect(running.status().map((s) => [s.u, s.name, s.hotplug ?? false])).toEqual([
      [1, "lower", true],
      [2, "upper", true],
      [3, "host", false],
    ]);
    expect(await host(running).names()).toEqual(["lower", "upper"]);
    expect(await host(running).run("upper", "Hi")).toBe("HI");
    expect((await app.read("test.plan")).split("\n").slice(2)).toEqual(["U1 host host -", ""]);
    expect(rec.logs.map((entry) => entry.message)).toContain(
      "hot-plug directory plugins/ holds 2 device files",
    );
  });

  test("a reload plugs the device of a new file, swaps a changed one, and unplugs a removed one, and the plan file stays as it is", async () => {
    const app = await hotplugApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir, plan: "update" });
    const planFile = join(app.dir, "test.plan");
    const plan = [await app.read("test.plan"), (await stat(planFile)).mtimeMs];
    await app.write("plugins/twice.ts", tool("twice", "text + text"));
    const plugged = await running.reload();
    expect(plugged.map((result) => [result.device, result.mode, result.error ?? null])).toEqual([
      ["twice", "plug", null],
    ]);
    expect(await host(running).names()).toEqual(["lower", "twice", "upper"]);
    expect(await host(running).run("twice", "ab")).toBe("abab");
    await app.write("plugins/lower.ts", tool("lower", '"_" + text.toLowerCase()'));
    await running.reload();
    expect(await host(running).run("lower", "Hi")).toBe("_hi");
    await rm(join(app.dir, "plugins", "upper.ts"));
    const unplugged = await running.reload();
    expect(unplugged.map((result) => [result.device, result.mode])).toEqual([["upper", "unplug"]]);
    expect(await host(running).names()).toEqual(["lower", "twice"]);
    expect(names(running)).toEqual(["lower", "twice", "host"]);
    expect([await app.read("test.plan"), (await stat(planFile)).mtimeMs]).toEqual(plan);
    expect(running.status().find((s) => s.name === "host")?.state).toBe("online");
  });

  test("a file that can't run is left out with a log entry, and the rest of the rack starts", async () => {
    const app = await hotplugApp();
    await app.write("plugins/broken.ts", "export default device({");
    await app.write("plugins/plain.ts", "export default 42;\n");
    await app.write("plugins/host.ts", tool("host", "text"));
    await app.write("plugins/twin-a.ts", tool("twin", "text"));
    await app.write("plugins/twin-b.ts", tool("twin", "text"));
    await app.write(
      "plugins/needy.ts",
      tool("needy", "text", "\n  needs: { other: Host },").replace(
        'import { Tool } from "../connectors.ts";',
        'import { Host, Tool } from "../connectors.ts";',
      ),
    );
    await app.write(
      "plugins/greedy.ts",
      tool("greedy", "text", "\n  needs: { tools: every(Tool) },").replace(
        'import { device } from "rack42u";',
        'import { device, every } from "rack42u";',
      ),
    );
    await app.write(
      "plugins/failing.ts",
      `import { device } from "rack42u";
import { Tool } from "../connectors.ts";

export default device({
  model: "failing",
  provides: { tool: Tool },
  powerOn() {
    throw new Error("no power");
  },
});
`,
    );
    await app.write(
      "plugins/refusing.ts",
      tool("refusing", "text", '\n  selfTest() { throw new Error("not ready"); },'),
    );
    const { running, rec } = await startRack(SPEC, { baseDir: app.dir });
    expect(names(running)).toEqual(["lower", "upper", "host"]);
    expect(await host(running).names()).toEqual(["lower", "upper"]);
    const warnings = rec.logs.filter((entry) => entry.level === "warn").map((e) => e.message);
    const leftOut = (file: string, reason: string) =>
      expect(warnings).toContainEqual(
        expect.stringMatching(
          new RegExp(`^${RegExp.escape(join("plugins", file))} left out: .*${reason}`),
        ),
      );
    leftOut("broken.ts", "");
    leftOut("plain.ts", "");
    leftOut("host.ts", "model host is the model of");
    leftOut("twin-a.ts", "another hot-plug file declares model twin too");
    leftOut("twin-b.ts", "another hot-plug file declares model twin too");
    leftOut("needy.ts", "it needs host, which sits above host");
    leftOut("greedy.ts", "is an every need, which a hot-plug device can't have");
    leftOut("failing.ts", "no power");
    leftOut("refusing.ts", "not ready");
  });

  test("a file that is left out runs at the reload after it is fixed", async () => {
    const app = await hotplugApp();
    await app.write("plugins/twice.ts", "export default device({");
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    expect(await host(running).names()).toEqual(["lower", "upper"]);
    await app.write("plugins/twice.ts", tool("twice", "text + text"));
    await running.reload();
    expect(await host(running).names()).toEqual(["lower", "twice", "upper"]);
  });

  test("a changed file that doesn't build keeps its device on the firmware it runs, degraded", async () => {
    const app = await hotplugApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    await app.write("plugins/upper.ts", "export default device({");
    const results = await running.reload();
    expect(results.map((result) => [result.device, result.error?.code ?? null])).toEqual([
      ["upper", "RACK_SWAP_REJECTED"],
    ]);
    expect(running.status().find((s) => s.name === "upper")?.state).toBe("degraded");
    expect(await host(running).run("upper", "Hi")).toBe("HI");
  });

  test("hot-plug devices that don't fit the rack are left out, last in order first", async () => {
    const app = await hotplugApp();
    const { running, rec } = await startRack({ ...SPEC, size: 2 }, { baseDir: app.dir });
    expect(names(running)).toEqual(["lower", "host"]);
    expect(rec.logs.map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(
        `${join("plugins", "upper.ts")} left out: the rack has no room for it`,
      ),
    );
  });

  test("the reload of hot-plug devices alone, which the watch of rack start runs, leaves the fixed devices on their firmware", async () => {
    const app = await hotplugApp();
    const { running } = await startRack(SPEC, { baseDir: app.dir });
    const firmware = () => running.status().find((s) => s.name === "host")?.firmware;
    const before = firmware();
    await app.write(
      "devices/host.ts",
      HOST.replace("let changes = 0;", "let changes = 0;\nconst edited = 1;\nvoid edited;"),
    );
    await app.write("plugins/twice.ts", tool("twice", "text + text"));
    await reloadHotplug(running);
    expect(await host(running).names()).toEqual(["lower", "twice", "upper"]);
    expect(firmware()).toBe(before);
    await running.reload();
    expect(firmware()).not.toBe(before);
  });

  test("rack plan lists the hot-plug devices with their slots, and the files left out", async () => {
    const app = await hotplugApp();
    await app.write("plugins/broken.ts", "export default device({");
    const report = await planRack(rack("test", SPEC), { baseDir: app.dir }, false);
    expect(report.text.split("\n").slice(2)).toEqual(["U1 host host -", ""]);
    expect(report.hotplug).toEqual(["U1 lower lower -", "U2 upper upper -"]);
    expect(report.leftOut.map((entry) => entry.path)).toEqual([join("plugins", "broken.ts")]);
  });
});

describe("hot-plug directories in the manifest", () => {
  test("a directory outside the base directory, or one that overlaps a devices directory, fails the manifest", async () => {
    expect(() => rack("test", { ...SPEC, hotplug: ["../plugins"] })).toThrow(
      "must be a relative path inside the base directory",
    );
    const app = await hotplugApp();
    const overlap = await errorOf(
      startRack({ ...SPEC, hotplug: ["./devices/more"] }, { baseDir: app.dir }),
    );
    expect([overlap.code, overlap.message]).toEqual([
      "RACK_MANIFEST",
      "hotplug directory devices/more overlaps the devices directory ./devices",
    ]);
  });

  test("a root that names a hot-plug model fails the manifest, and a missing directory holds no devices", async () => {
    const app = await hotplugApp();
    const root = await errorOf(
      startRack({ ...SPEC, roots: ["host", "upper"] }, { baseDir: app.dir }),
    );
    expect([root.code, root.message]).toEqual([
      "RACK_MANIFEST",
      "root upper is not a scanned device model",
    ]);
    const { running, rec } = await startRack(
      { ...SPEC, hotplug: ["./more"] },
      { baseDir: app.dir },
    );
    expect(names(running)).toEqual(["host"]);
    expect(rec.logs.map((entry) => entry.message)).toContain(
      "hot-plug directory more/ doesn't exist",
    );
  });

  test("rack compile refuses a manifest with hot-plug directories", async () => {
    const app = await hotplugApp();
    const error = await errorOf(compileRack(join(app.dir, "rack.ts"), rack("app", SPEC)));
    expect([error.code, error.message]).toEqual([
      "RACK_MANIFEST",
      "rack.ts has hot-plug directories, which an executable doesn't run; run the rack with rack start",
    ]);
  });
});

describe("the rack command with hot-plug directories", () => {
  const running: Cli[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((cli) => cli.stop()));
  });

  test("rack start watches the hot-plug directories, and applies their changes alone", async () => {
    const app = await hotplugApp();
    await app.write(
      "rack.ts",
      `import { rack } from "rack42u";\n\nexport default rack("app", ${JSON.stringify(SPEC)});\n`,
    );
    const cli = new Cli(["start"], app.dir);
    running.push(cli);
    await cli.waitFor(/watching the hot-plug directories plugins\/ for changes/);
    // A fixed device's file changes too, which waits for rack ctl reload.
    await app.write(
      "devices/host.ts",
      HOST.replace("let changes = 0;", "let changes = 0;\nconst edited = 1;\nvoid edited;"),
    );
    await app.write("plugins/twice.ts", tool("twice", "text + text"));
    await cli.waitFor(/twice plugged in at U/);
    // Reloads run one at a time, so once a later file's device is plugged in, the reload before
    // it has ended.
    await app.write("plugins/third.ts", tool("third", "text"));
    await cli.waitFor(/third plugged in at U/);
    expect(cli.output).not.toContain("host swapped");
    await rm(join(app.dir, "plugins", "upper.ts"));
    await cli.waitFor(/upper unplugged/);
    expect(cli.process.exitCode).toBeNull();
  }, 30_000);
});
