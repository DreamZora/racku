/**
 * Tests for the `rack` command line.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 */
import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cli,
  FIXTURES,
  ROOT,
  type TempApp,
  tempApp,
  useControlDir,
  WINDOWS,
} from "./fixtures/app.ts";

const MANIFEST = `import { rack, slot } from "rack42u";
import { httpPanel } from "rack42u/std";

export default rack("cli", {
  slots: {
    1: slot("./devices/counter.ts"),
    3: slot("./devices/web.ts"),
    4: httpPanel({ port: 0, routes: { "/web/*": "web.http" } }),
  },
});
`;

const apps: TempApp[] = [];
const processes: Cli[] = [];
useControlDir();

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
  // @doc docs/guides/running.md#the-rack-command
  // @doc docs/guides/running.md#windows
  // @doc docs/reference/cli.md#commands
  test("starts the rack in rack.ts, serves the panel, and shuts down in order on SIGINT", async () => {
    const { dir } = await app();
    const cli = run(["start"], dir);
    const url = await cli.panelUrl();
    expect(await greeting(url)).toBe("hello");
    cli.kill("SIGINT");
    expect(await cli.exited()).toBe(0);
    const panel = cli.output.indexOf("[rack] info http-panel powered off");
    const web = cli.output.indexOf("[rack] info web powered off");
    const counter = cli.output.indexOf("[rack] info counter powered off");
    expect(panel).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(panel);
    expect(counter).toBeGreaterThan(web);
    expect(cli.output).toContain("[rack] info rack cli stopped");
  });

  // @doc docs/guides/running.md#a-layout-that-follows-data
  // @doc docs/guides/running.md#running-a-rack-from-another-program
  test("rack ctl reload replaces a device whose file changed, and doesn't read an edited manifest", async () => {
    const created = await app();
    const cli = run(["start"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/control listening/);
    await created.write("rack.ts", MANIFEST.replace('"/web/*"', '"/web/greeting"'));
    const reload = run(["ctl", "reload"], created.dir);
    expect(await reload.exited()).toBe(0);
    expect(JSON.parse(reload.output)).toEqual([]);
    // The panel still routes all of /web, as the manifest the rack started with says.
    expect((await fetch(new URL("/web/echo", url))).status).toBe(200);

    const source = await created.read("devices/web.ts");
    await created.write("devices/web.ts", source.replace('"hello"', '"hello again"'));
    const again = run(["ctl", "reload"], created.dir);
    expect(await again.exited()).toBe(0);
    expect(JSON.parse(again.output)).toEqual([
      expect.objectContaining({ device: "web", mode: "hot" }),
    ]);
    expect(await greeting(url)).toBe("hello again");
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
    "on Windows, Ctrl-Break stops rack start and rack dev in order",
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

  // @doc docs/reference/cli.md#exit-codes
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

  // @doc docs/reference/cli.md#exit-codes
  test("exits with code 1 when the rack fails to start", async () => {
    const created = await app(`import { rack, slot } from "rack42u";
export default rack("broken", { slots: { 1: slot("./devices/missing.ts") } });
`);
    const cli = run(["start"], created.dir);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain("rack: RACK_MANIFEST:");
  });

  // @doc docs/reference/cli.md#exit-codes
  test("exits with code 1 when the manifest cannot be loaded", async () => {
    const { dir } = await app();
    const cli = run(["start", "nowhere.ts"], dir);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain("rack: cannot load");
  });

  // @doc docs/reference/cli.md#exit-codes
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

/** A program that runs a rack and is killed in a test. */
const HOST_PROGRAM = join(FIXTURES, "host-program.ts");

describe("configuration from the program", () => {
  // @doc docs/guides/running.md#running-a-rack-from-another-program
  test("a manifest takes values from the environment that the program gives the rack", async () => {
    const created = await app(MANIFEST.replace("port: 0", "port: Number(process.env.PANEL_PORT)"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = String(server.port);
    await server.stop(true);
    const cli = run(["start"], created.dir, { PANEL_PORT: port });
    expect(new URL(await cli.panelUrl()).port).toBe(port);
  });
});

/** A device that logs a `bigint`, a warning, and circular details. */
const NOISY = `import { device } from "rack42u";

export default device({
  model: "noisy",
  activate(ctx) {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    ctx.log.info("big", { value: 2n ** 64n });
    ctx.log.warn("a warning");
    ctx.log.info("circular", loop);
  },
});
`;

// @decision .agents/decisions/261118_173838-running-under-another-program.md#tests
describe("running under another program", () => {
  // @doc docs/guides/running.md#running-a-rack-from-another-program
  // @doc docs/reference/cli.md#flags-of-rack-start-and-rack-dev
  test("with --stop-on-stdin-close, rack start and rack dev stop in order with code 0 when their input closes", async () => {
    const { dir } = await app();
    for (const command of ["start", "dev"]) {
      const cli = run([command, "--stop-on-stdin-close"], dir);
      expect(await greeting(await cli.panelUrl())).toBe("hello");
      await cli.closeInput();
      expect(await cli.exited()).toBe(0);
      expect(cli.output).toContain("[rack] info standard input closed");
      const panel = cli.output.indexOf("[rack] info http-panel powered off");
      expect(panel).toBeGreaterThan(-1);
      expect(cli.output.indexOf("[rack] info rack cli stopped")).toBeGreaterThan(panel);
    }
  });

  // Starting a program that starts a rack takes longer than Bun's default 5 s on Windows.
  // @doc docs/guides/running.md#running-a-rack-from-another-program
  test("a rack with --stop-on-stdin-close stops in order when the program that runs it is killed", async () => {
    const { dir } = await app();
    const cli = join(ROOT, "src", "cli.ts");
    const host = new Cli([], dir, {}, [
      process.execPath,
      HOST_PROGRAM,
      cli,
      "start",
      "--stop-on-stdin-close",
    ]);
    processes.push(host);
    const pid = Number((await host.waitFor(/child pid (\d+)/))[1]);
    try {
      await host.panelUrl();
      host.process.kill("SIGKILL");
      await host.waitFor(/\[rack\] info rack cli stopped/, 20_000);
      // The rack shares the program's output, which ends once the rack has exited too.
      await host.ended;
      expect(host.output).toContain("[rack] info standard input closed");
      expect(host.output).toContain("[rack] info http-panel powered off");
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The rack has exited, as it should.
      }
    }
  }, 30_000);

  // @doc docs/reference/cli.md#flags-of-rack-start-and-rack-dev
  test("without --stop-on-stdin-close, closing standard input changes nothing", async () => {
    const { dir } = await app();
    const cli = new Cli(["start"], dir, {}, undefined, "pipe");
    processes.push(cli);
    const url = await cli.panelUrl();
    await cli.closeInput();
    await Bun.sleep(500);
    expect(await greeting(url)).toBe("hello");
    expect(cli.process.exitCode).toBeNull();
  });

  // @doc docs/guides/running.md#running-a-rack-from-another-program
  // @doc docs/reference/cli.md#flags-of-rack-start-and-rack-dev
  // @doc docs/reference/reports.md#the-log
  test("--log json writes each entry as one line of JSON on stdout, warnings included", async () => {
    const created = await app(
      MANIFEST.replace("4: httpPanel", '2: slot("./devices/noisy.ts"),\n    4: httpPanel'),
    );
    await created.write("devices/noisy.ts", NOISY);
    const cli = run(["start", "--log", "json"], created.dir);
    await cli.waitFor(/"message":"control listening"/);
    cli.kill("SIGINT");
    expect(await cli.exited()).toBe(0);
    const entries = cli.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Bun's toMatchObject writes asymmetric matchers into the object it checks, so the types are
    // checked one by one.
    for (const entry of entries) {
      expect([typeof entry.time, typeof entry.level, typeof entry.message]).toEqual([
        "number",
        "string",
        "string",
      ]);
    }
    const listening = entries.find(
      (entry) => entry.message === "listening" && entry.device === "http-panel",
    );
    expect(listening).toBeDefined();
    const url = new URL((listening?.data as { url: string } | undefined)?.url ?? "");
    expect(url.port).not.toBe("0");
    expect(entries).toContainEqual(
      expect.objectContaining({ device: "noisy", data: { value: "18446744073709551616n" } }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ device: "noisy", level: "warn", message: "a warning" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ device: "noisy", message: "circular", data: "[object Object]" }),
    );
    expect(entries).toContainEqual(expect.objectContaining({ message: "rack cli started" }));
    const control = entries.find((entry) => entry.message === "control listening");
    expect(typeof (control?.data as { address?: unknown } | undefined)?.address).toBe("string");
    expect(entries).toContainEqual(expect.objectContaining({ message: "rack cli stopped" }));
  });

  // @doc docs/reference/cli.md#exit-codes
  test("an unknown --log format is a usage error, with code 2", async () => {
    const { dir } = await app();
    const cli = run(["start", "--log", "xml"], dir);
    expect(await cli.exited()).toBe(2);
    expect(cli.output).toContain("usage: rack");
    expect(cli.stdout).toBe("");
  });

  // @doc docs/reference/cli.md#flags-of-rack-start-and-rack-dev
  // @doc docs/reference/cli.md#exit-codes
  test("a stop during a shutdown that rack ctl stop began ends it at once with code 1", async () => {
    const created = await app(`import { rack, slot } from "rack42u";
export default rack("slow", {
  slots: { 1: slot("./devices/lifecycle.ts", { config: { slowDeactivateMs: 5000 } }) },
});
`);
    const cli = run(["start", "--stop-on-stdin-close"], created.dir);
    await cli.waitFor(/control listening/);
    const startedAt = Date.now();
    const ctl = run(["ctl", "stop"], created.dir);
    expect(await ctl.exited()).toBe(0);
    await cli.waitFor(/"hook":"deactivate"/);
    await cli.closeInput();
    expect(await cli.exited()).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(cli.output).toContain(
      "rack: standard input closed, exiting without finishing the shutdown",
    );
  });
});

describe("the rack bin", () => {
  // In an app that depends on rack42u, the package's `rack` command runs the CLI.
  // @decision .agents/decisions/261118_015204-windows.md#changes-to-the-repository-and-the-tests
  // @doc README.md#quick-start
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

// @doc docs/guides/running.md#hot-reload-with-rack-dev
describe("rack dev", () => {
  // @doc docs/guides/running.md#running-a-rack-from-another-program
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
  // @doc docs/guides/updates.md#changed-plans-and-edited-manifests
  test("applies an edited manifest without a restart", async () => {
    const created = await app();
    const cli = run(["dev"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    expect((await fetch(new URL("/web/echo", url))).status).toBe(200);
    // Narrow the route to one path: the panel's configuration changed, so the rack replaces the
    // panel, which keeps its port; the device keeps serving the path, and the panel stops
    // routing the rest of /web to it.
    await created.write("rack.ts", MANIFEST.replace('"/web/*"', '"/web/greeting"'));
    await cli.waitFor(/the manifest changed; applying it/);
    await cli.waitFor(/\[rack\] info http-panel swapped/);
    expect(await greeting(url)).toBe("hello");
    const echo = await fetch(new URL("/web/echo", url));
    expect([echo.status, await echo.json()]).toEqual([
      404,
      { code: "RACK_NO_ROUTE", message: "no route matches" },
    ]);
    expect(cli.output).not.toMatch(/(web|counter) swapped/);
  });

  // An edited manifest is bundled before rack dev imports it again, and keeps the import.meta of
  // its own file, as it had when the rack started.
  test("applies an edited manifest that reads a file next to it", async () => {
    const manifest = (comment: string) => `import { readFileSync } from "node:fs";
import { rack, slot } from "rack42u";
import { httpPanel } from "rack42u/std";
${comment}
const routes = JSON.parse(readFileSync(new URL("./routes.json", import.meta.url), "utf8"));
const { url, dir, dirname, path, filename } = {
  url: import.meta.url,
  dir: import.meta.dir,
  dirname: import.meta.dirname,
  path: import.meta.path,
  filename: import.meta.filename,
};
console.log("import.meta", JSON.stringify({ url, dir, dirname, path, filename }));

export default rack("cli", {
  slots: {
    1: slot("./devices/counter.ts"),
    3: slot("./devices/web.ts"),
    4: httpPanel({ port: 0, routes: { [routes.web]: "web.http" } }),
  },
});
`;
    const created = await app(manifest(""));
    await created.write("routes.json", JSON.stringify({ web: "/web/*" }));
    const cli = run(["dev"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    expect((await fetch(new URL("/web/echo", url))).status).toBe(200);

    await created.write("routes.json", JSON.stringify({ web: "/web/greeting" }));
    await created.write("rack.ts", manifest("// Edited: the routes come from routes.json."));
    await cli.waitFor(/\[rack\] info http-panel swapped|reload failed/);
    expect(cli.output).not.toContain("reload failed");
    expect((await fetch(new URL("/web/echo", url))).status).toBe(404);
    expect(await greeting(url)).toBe("hello");

    // The paths of the manifest's own file, at the start and after the edit. Compared as real
    // paths, since a temporary directory can lie behind a symlink, as on macOS.
    const source = realpathSync(join(created.dir, "rack.ts"));
    const here = [source, dirname(source), dirname(source), source, source];
    const seen = [...cli.output.matchAll(/^import\.meta (.*)$/gm)].map(([, json = ""]) => {
      const meta = JSON.parse(json) as Record<string, string>;
      const paths = [
        fileURLToPath(meta.url ?? ""),
        meta.dir,
        meta.dirname,
        meta.path,
        meta.filename,
      ];
      return paths.map((path) => realpathSync(path ?? ""));
    });
    expect(seen).toEqual([here, here]);
  });

  // @doc docs/guides/running.md#a-layout-that-follows-data
  test("doesn't read the manifest again when only a file that it reads changes", async () => {
    const created = await app(`import { readFileSync } from "node:fs";
import { rack, slot } from "rack42u";
import { httpPanel } from "rack42u/std";

const routes = JSON.parse(readFileSync(new URL("./routes.json", import.meta.url), "utf8"));

export default rack("cli", {
  slots: {
    1: slot("./devices/counter.ts"),
    3: slot("./devices/web.ts"),
    4: httpPanel({ port: 0, routes: { [routes.web]: "web.http" } }),
  },
});
`);
    await created.write("routes.json", JSON.stringify({ web: "/web/*" }));
    const cli = run(["dev"], created.dir);
    const url = await cli.panelUrl();
    await cli.waitFor(/watching /);
    expect((await fetch(new URL("/web/echo", url))).status).toBe(200);
    await created.write("routes.json", JSON.stringify({ web: "/web/greeting" }));
    await cli.waitFor(/reload: no firmware changed/);
    expect(cli.output).not.toContain("the manifest changed");
    expect((await fetch(new URL("/web/echo", url))).status).toBe(200);
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

  // Bun 1.4.4 reports the removal of a watched directory without a file name, which ended
  // rack dev at once with code 1 when its watcher took every name for a string.
  // @decision .agents/decisions/261120_221450-watching-outside-files.md#failure-modes
  test("stops watching when its base directory is removed, and still stops in order", async () => {
    const created = await app();
    // Run from elsewhere, since a system may refuse to remove a process's working directory.
    const cli = run(["dev", join(created.dir, "rack.ts"), "--stop-on-stdin-close"], tmpdir());
    await cli.panelUrl();
    await cli.waitFor(/watching /);
    await rm(created.dir, { recursive: true, force: true });
    await cli.waitFor(/\[rack\] error stopped watching .*: it was removed/);
    await cli.closeInput();
    expect(await cli.exited()).toBe(0);
    expect(cli.output).toContain("rack cli stopped");
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
