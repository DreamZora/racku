/**
 * Tests for the `rack` command line.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, rmdir, unlink } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Cli, FIXTURES, ROOT, type TempApp, tempApp, WINDOWS } from "./fixtures/app.ts";

const MANIFEST = `import { rack, slot } from "rack42u";

export default rack("cli", {
  slots: {
    1: slot("./devices/counter.ts"),
    3: slot("./devices/web.ts"),
  },
  panel: { http: { port: 0, routes: { "/web/*": "web.http" } } },
});
`;

const apps: TempApp[] = [];
const processes: Cli[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

async function app(manifest = MANIFEST): Promise<TempApp> {
  const created = await tempApp(["connectors.ts", "devices"], FIXTURES);
  apps.push(created);
  await created.write("rack.ts", manifest);
  return created;
}

function run(args: string[], cwd: string, env?: Record<string, string>): Cli {
  const cli = new Cli(args, cwd, env);
  processes.push(cli);
  return cli;
}

async function greeting(url: string): Promise<string> {
  return (await fetch(new URL("/web/greeting", url))).text();
}

describe("rack start", () => {
  test("starts the rack in rack.ts, serves the panel, and shuts down in order on SIGINT", async () => {
    const { dir } = await app();
    const cli = run(["start"], dir);
    const url = await cli.panelUrl();
    expect(await greeting(url)).toBe("hello");
    cli.kill("SIGINT");
    expect(await cli.exited()).toBe(0);
    const web = cli.output.indexOf("[rack] info web powered off");
    const counter = cli.output.indexOf("[rack] info counter powered off");
    expect(web).toBeGreaterThan(-1);
    expect(counter).toBeGreaterThan(web);
    expect(cli.output).toContain("[rack] info rack cli stopped");
  });

  // Windows has no SIGTERM.
  // @decision .agents/decisions/261118_015204-windows.md#differences-the-readme-states
  test.skipIf(WINDOWS)("shuts down on SIGTERM too", async () => {
    const { dir } = await app();
    const cli = run(["start", "rack.ts"], dir);
    await cli.panelUrl();
    cli.kill("SIGTERM");
    expect(await cli.exited()).toBe(0);
  });

  // README.md, "Running a rack" and "Windows". Only Windows sends SIGBREAK.
  // @decision .agents/decisions/261118_015204-windows.md#changes-to-the-rack
  test.skipIf(!WINDOWS)(
    "README.md: on Windows, Ctrl-Break stops rack start and rack dev in order",
    async () => {
      const { dir } = await app();
      for (const command of ["start", "dev"]) {
        const cli = run([command], dir);
        await cli.panelUrl();
        cli.kill("SIGBREAK");
        expect(await cli.exited()).toBe(0);
        expect(cli.output).toContain("[rack] info rack cli stopped");
      }
    },
  );

  test("a second signal during shutdown exits at once with code 1", async () => {
    const created = await app(`import { rack, slot } from "rack42u";
export default rack("slow", {
  slots: { 1: slot("./devices/lifecycle.ts", { config: { slowDeactivateMs: 5000 } }) },
});
`);
    const cli = run(["start"], created.dir);
    await cli.waitFor(/rack slow started/);
    const startedAt = Date.now();
    cli.kill("SIGINT");
    await cli.waitFor(/"hook":"deactivate"/);
    cli.kill("SIGINT");
    expect(await cli.exited()).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  test("exits with code 1 when the rack fails to start", async () => {
    const created = await app(`import { rack, slot } from "rack42u";
export default rack("broken", { slots: { 1: slot("./devices/missing.ts") } });
`);
    const cli = run(["start"], created.dir);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain("rack: RACK_MANIFEST:");
  });

  test("exits with code 1 when the manifest cannot be loaded", async () => {
    const { dir } = await app();
    const cli = run(["start", "nowhere.ts"], dir);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain("rack: cannot load");
  });

  test("prints usage and exits with code 2 for an unknown command", async () => {
    const { dir } = await app();
    const cli = run(["launch"], dir);
    expect(await cli.exited()).toBe(2);
    expect(cli.output).toContain("usage: rack <start|dev>");
  });
});

/** The name of the PATH variable, which Windows spells `Path`. */
const PATH = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

/** Removes a link to a directory, and never what it points to. */
async function removeLink(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch {
    // Never created: nothing links anywhere.
    return;
  }
  try {
    await unlink(path);
  } catch {
    // Windows removes a link to a directory as a directory, which rmdir does without recursing.
    await rmdir(path);
  }
}

describe("the rack bin", () => {
  // README.md: in an app that depends on rack42u, the package's `rack` command runs the CLI.
  // @decision .agents/decisions/261118_015204-windows.md#changes-to-the-repository-and-the-tests
  test("runs the CLI through what bun link writes to node_modules/.bin", async () => {
    const created = await app();
    // bun link records the package in Bun's global directory: one inside the app spares the
    // user's own.
    const bunInstall = join(created.dir, ".bun");
    const env = { ...process.env, BUN_INSTALL: bunInstall };
    // The links that bun link makes into this repository.
    const links = [
      join(bunInstall, "install", "global", "node_modules", "rack42u"),
      join(created.dir, "node_modules", "rack42u"),
    ];
    try {
      expect(Bun.spawnSync([process.execPath, "link"], { cwd: ROOT, env }).exitCode).toBe(0);
      const linked = Bun.spawnSync([process.execPath, "link", "rack42u"], {
        cwd: created.dir,
        env,
      });
      expect(linked.exitCode).toBe(0);
      // A symlink to src/cli.ts, or on Windows a shim that runs it with bun.
      const bin = join(created.dir, "node_modules", ".bin", WINDOWS ? "rack.exe" : "rack");
      const cli = new Cli(
        [],
        created.dir,
        // The bin runs `bun` from PATH; use the Bun that runs the tests.
        { [PATH]: `${dirname(process.execPath)}${delimiter}${process.env[PATH] ?? ""}` },
        [bin, "start"],
      );
      processes.push(cli);
      const url = await cli.panelUrl();
      expect(await greeting(url)).toBe("hello");
      cli.kill("SIGINT");
      expect(await cli.exited()).toBe(0);
    } finally {
      // One by one, so that removing the app can never follow them into this repository.
      for (const link of links) await removeLink(link);
    }
  });
});

describe("rack dev", () => {
  test("swaps a device after its file changes", async () => {
    const created = await app();
    const cli = run(["dev"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    expect(await greeting(url)).toBe("hello");

    const source = await created.read("devices/web.ts");
    await created.write("devices/web.ts", source.replace('"hello"', '"hello again"'));
    await cli.waitFor(/\[rack\] info web swapped/);
    expect(await greeting(url)).toBe("hello again");
    expect(cli.output).not.toContain("counter swapped");
  });

  // README.md, "Running a rack": rack dev applies an edited manifest without a restart.
  // @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
  test("README.md: applies an edited manifest without a restart", async () => {
    const created = await app();
    const cli = run(["dev"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    expect((await fetch(new URL("/web/echo", url))).status).toBe(200);
    // Narrow the route to one path: the device keeps serving it, and the panel stops routing
    // the rest of /web to it.
    await created.write("rack.ts", MANIFEST.replace('"/web/*"', '"/web/greeting"'));
    await cli.waitFor(/the manifest changed; applying it/);
    await cli.waitFor(/reload: no firmware changed/);
    expect(await greeting(url)).toBe("hello");
    const echo = await fetch(new URL("/web/echo", url));
    expect([echo.status, await echo.text()]).toEqual([404, "Not Found"]);
  });

  test("ignores changes under node_modules and dot directories", async () => {
    const created = await app();
    const cli = run(["dev"], created.dir);
    await cli.panelUrl();
    await cli.waitFor(/watching /);
    await created.write(".cache/state.txt", "x");
    await created.write("node_modules/.scratch.txt", "x");
    await Bun.sleep(500);
    expect(cli.output).not.toContain("reload:");
    await created.write("notes.txt", "x");
    await cli.waitFor(/reload: no firmware changed/);
  });

  test("reports a device that fails to build and keeps serving", async () => {
    const created = await app();
    const cli = run(["dev"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    await created.write("devices/web.ts", "export default device({ model: ;\n");
    await cli.waitFor(/swap of web failed: firmware build failed/);
    expect(await greeting(url)).toBe("hello");
  });
});
