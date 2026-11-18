/**
 * Tests for the management endpoint and `rack ctl`: a Unix socket guarded by file permissions,
 * loopback TCP guarded by a token, and the operations of the rack handle behind both.
 *
 * @decision .agents/decisions/261117_005821-management-endpoint.md#transports
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-unix-socket
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-tcp-endpoint
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-protocol
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-command
 * @decision .agents/decisions/261117_182058-ci-on-main-and-on-request.md#decision
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type SlotStatus, slot } from "rack42u";
import { type ControlFile, controlPaths, controlTransport } from "../src/control.ts";
import {
  Cli,
  CONTROL_DIR,
  errorOf,
  FIXTURES,
  type TempApp,
  tempApp,
  useRacks,
} from "./fixtures/app.ts";

const startRack = useRacks();

/** Windows has no Unix sockets and no file modes; tests that need them skip it. */
const WINDOWS = process.platform === "win32";

// In-process racks use the same runtime directory as the rack processes the tests start.
let savedRuntime: string | undefined;
beforeAll(() => {
  savedRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = CONTROL_DIR;
});
afterAll(() => {
  if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedRuntime;
});

const apps: TempApp[] = [];
const processes: Cli[] = [];
afterEach(async () => {
  for (const cli of processes.splice(0)) cli.kill("SIGKILL");
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const MANIFEST = `import { rack, slot } from "rack42u";

export default rack("ctl", { slots: { 1: slot("./devices/counter.ts") } });
`;

async function app(): Promise<TempApp> {
  const created = await tempApp(["connectors.ts", "devices"], FIXTURES);
  apps.push(created);
  await created.write("rack.ts", MANIFEST);
  return created;
}

function run(args: string[], cwd: string, env: Record<string, string> = {}): Cli {
  const cli = new Cli(args, cwd, env);
  processes.push(cli);
  return cli;
}

/**
 * A rack's status as a pattern: the watchdogs' feed times move between two reads.
 *
 * @decision .agents/decisions/261117_062959-watchdog.md#configuration-and-observation
 */
function statusOf(running: { status(): SlotStatus[] }): unknown {
  return running.status().map((device) => ({
    ...device,
    watchdogs: device.watchdogs.map((watchdog) => ({ ...watchdog, lastFed: expect.any(Number) })),
  }));
}

async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

/** Sends one raw HTTP request, so that tests control every header, Host included. */
async function raw(url: string, request: string): Promise<number> {
  const { hostname, port } = new URL(url);
  const response = await new Promise<string>((resolve, reject) => {
    let text = "";
    Bun.connect({
      hostname,
      port: Number(port),
      socket: {
        open: (socket) => {
          socket.write(request);
        },
        data: (_socket, chunk) => {
          text += chunk.toString();
        },
        close: () => resolve(text),
        error: (_socket, error) => reject(error),
      },
    }).catch(reject);
  });
  return Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]);
}

describe.skipIf(WINDOWS)("the Unix socket", () => {
  // README.md, "Managing a running rack".
  test("README.md: rack start opens a socket only its user can use, and rack ctl operates the rack through it", async () => {
    const created = await app();
    const rack = run(["start"], created.dir);
    await rack.waitFor(/control listening/);
    const paths = controlPaths(created.dir);
    expect([await mode(paths.dir), await mode(paths.socket)]).toEqual(["700", "600"]);

    const status = run(["ctl", "status"], created.dir);
    expect(await status.exited()).toBe(0);
    expect(JSON.parse(status.output)).toEqual([
      expect.objectContaining({ name: "counter", state: "online" }),
    ]);

    const restart = run(["ctl", "restart", "counter"], created.dir);
    expect(await restart.exited()).toBe(0);
    expect(JSON.parse(restart.output)).toEqual([
      expect.objectContaining({ device: "counter", mode: "restart" }),
    ]);

    const history = run(["ctl", "history", "counter"], created.dir);
    expect(await history.exited()).toBe(0);
    expect(JSON.parse(history.output)[0]).toMatchObject({ cause: "restart", ok: true });

    const stop = run(["ctl", "stop"], created.dir);
    expect(await stop.exited()).toBe(0);
    expect(await rack.exited()).toBe(0);
    expect(existsSync(paths.socket)).toBe(false);
  });

  test("README.md: a stale socket is replaced, and a second rack refuses to start while one answers", async () => {
    const created = await app();
    const spec = { slots: { 1: slot("./devices/counter.ts") } };
    const paths = controlPaths(created.dir);
    await mkdir(paths.dir, { recursive: true });
    await chmod(paths.dir, 0o755);
    await Bun.write(paths.socket, "left over by a rack that crashed\n");
    const { running } = await startRack(spec, { baseDir: created.dir, control: true });
    // The directory existed with looser permissions; the rack narrowed them.
    expect(await mode(paths.dir)).toBe("700");
    const answer = await fetch("http://localhost/v1/status", {
      method: "POST",
      unix: paths.socket,
      body: JSON.stringify({ args: [] }),
    });
    expect(await answer.json()).toEqual({ ok: true, value: statusOf(running) });
    const second = await errorOf(startRack(spec, { baseDir: created.dir, control: true }));
    expect([second.code, second.message]).toEqual([
      "RACK_MANIFEST",
      expect.stringContaining("another rack already answers"),
    ]);
  });
});

describe("the TCP endpoint", () => {
  test("README.md: the TCP endpoint takes requests only with the token, and refuses requests a web page sends", async () => {
    const created = await app();
    const { running } = await startRack(
      { slots: { 1: slot("./devices/counter.ts") } },
      { baseDir: created.dir, control: { port: 0 } },
    );
    const paths = controlPaths(created.dir);
    if (!WINDOWS) expect(await mode(paths.file)).toBe("600");
    const { url, token } = (await Bun.file(paths.file).json()) as ControlFile;
    const post = (op: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/v1/${op}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    expect(await (await post("status", { args: [] })).json()).toEqual({
      ok: true,
      value: statusOf(running),
    });
    expect((await fetch(`${url}/v1/status`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post("status", {}, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("status", {}, { origin: "https://example.com" })).status).toBe(403);
    const host = new URL(url).host;
    const foreign = `POST /v1/status HTTP/1.1\r\nHost: rebound.example:${new URL(url).port}\r\nAuthorization: Bearer ${token}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`;
    expect(await raw(url, foreign)).toBe(403);
    const own = foreign.replace(/Host: [^\r]+/, `Host: ${host}`);
    expect(await raw(url, own)).toBe(200);
    expect(
      (await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(405);
    expect((await post("explode", { args: [] })).status).toBe(404);
    expect((await post("status", "not json")).status).toBe(400);
    expect((await post("swap", { args: [] })).status).toBe(400);
    expect(await (await post("swap", { args: ["ghost"] })).json()).toEqual({
      ok: false,
      error: { code: "RACK_NO_ROUTE", message: "no device named ghost" },
    });
    await running.stop();
    expect(existsSync(paths.file)).toBe(false);
  });

  test("README.md: RACK_CONTROL_TOKEN sets the token, and rack ctl reaches a rack by --url and --token", async () => {
    const created = await app();
    const rack = run(["start", "--control-port", "0"], created.dir, {
      RACK_CONTROL_TOKEN: "shared-secret",
    });
    await rack.waitFor(/control listening/);
    const { url, token } = (await Bun.file(controlPaths(created.dir).file).json()) as ControlFile;
    expect(token).toBe("shared-secret");
    const elsewhere = run(["ctl", "status", "--url", url, "--token", "shared-secret"], FIXTURES);
    expect(await elsewhere.exited()).toBe(0);
    expect(JSON.parse(elsewhere.output)[0]).toMatchObject({ name: "counter" });
    const wrong = run(["ctl", "status", "--url", url, "--token", "nope"], FIXTURES);
    expect(await wrong.exited()).toBe(1);
    expect(wrong.output).toContain("the rack answered 401");
  });
});

describe("transports by platform", () => {
  test("README.md: Linux and macOS default to the Unix socket, and Windows and --control-port to TCP", () => {
    expect(controlTransport(undefined, "linux")).toBe("unix");
    expect(controlTransport(undefined, "darwin")).toBe("unix");
    expect(controlTransport(undefined, "win32")).toBe("tcp");
    expect(controlTransport(0, "linux")).toBe("tcp");
  });

  test("README.md: the control file lives in the user's own state directory, never in the app", () => {
    const saved = { local: process.env.LOCALAPPDATA, runtime: process.env.XDG_RUNTIME_DIR };
    try {
      process.env.LOCALAPPDATA = "C:\\Users\\ada\\AppData\\Local";
      expect(controlPaths("/app", "win32").dir).toContain("rack42u");
      expect(controlPaths("/app", "win32").dir.startsWith(process.env.LOCALAPPDATA)).toBe(true);
      process.env.XDG_RUNTIME_DIR = "/run/user/1000";
      expect(controlPaths("/app", "linux").dir).toBe("/run/user/1000/rack42u");
      delete process.env.XDG_RUNTIME_DIR;
      expect(controlPaths("/app", "linux").dir).toContain(".local/state/rack42u/control");
      expect(controlPaths("/app", "linux").socket).not.toContain("/app/");
    } finally {
      if (saved.local === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved.local;
      process.env.XDG_RUNTIME_DIR = saved.runtime ?? CONTROL_DIR;
    }
  });
});

describe("the protocol", () => {
  test.skipIf(WINDOWS)(
    "README.md: operations from the endpoint and from code run one at a time, in call order",
    async () => {
      const created = await app();
      const { running } = await startRack(
        {
          slots: {
            1: slot("./devices/busy.ts", { config: { activateDelayMs: 150 } }),
          },
        },
        { baseDir: created.dir, control: true },
      );
      const fromCode = running.swap("busy");
      const fromEndpoint = fetch("http://localhost/v1/restart", {
        method: "POST",
        unix: controlPaths(created.dir).socket,
        body: JSON.stringify({ args: ["busy"] }),
      });
      await fromCode;
      expect(((await (await fromEndpoint).json()) as { ok: boolean }).ok).toBe(true);
      expect(running.history().map((record) => record.cause)).toEqual(["restart", "swap"]);
    },
  );

  test.skipIf(WINDOWS)(
    "README.md: plug takes its slot spec as { source, name, config }",
    async () => {
      const created = await app();
      const { running } = await startRack(
        { slots: { 1: slot("./devices/counter.ts") } },
        { baseDir: created.dir, control: true },
      );
      const answer = await fetch("http://localhost/v1/plug", {
        method: "POST",
        unix: controlPaths(created.dir).socket,
        body: JSON.stringify({ args: [3, { source: "./devices/counter.ts", name: "second" }] }),
      });
      expect(await answer.json()).toEqual({ ok: true, value: null });
      expect(running.status().map((s) => s.name)).toEqual(["counter", "second"]);
    },
  );

  test("rack ctl reports when no rack runs for the directory", async () => {
    const created = await app();
    const ctl = run(["ctl", "status"], created.dir);
    expect(await ctl.exited()).toBe(1);
    expect(ctl.output).toContain("no running rack has the base directory");
  });
});

describe.skipIf(!WINDOWS)("Windows defaults", () => {
  // README.md, "Managing a running rack". Runs only in CI's Windows job.
  test("README.md: on Windows, rack start listens on loopback TCP, writes its control file under %LOCALAPPDATA%, and rack ctl reaches it", async () => {
    const saved = process.env.LOCALAPPDATA;
    const local = join(CONTROL_DIR, "LocalAppData");
    process.env.LOCALAPPDATA = local;
    try {
      const created = await app();
      const rack = run(["start"], created.dir, { LOCALAPPDATA: local });
      await rack.waitFor(/control listening/);
      expect(rack.output).toMatch(/control listening .*http:\/\/127\.0\.0\.1:\d+/);
      const paths = controlPaths(created.dir);
      expect(paths.file.startsWith(join(local, "rack42u", "control"))).toBe(true);
      const { url } = (await Bun.file(paths.file).json()) as ControlFile;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const status = run(["ctl", "status"], created.dir, { LOCALAPPDATA: local });
      expect(await status.exited()).toBe(0);
      expect(JSON.parse(status.output)).toEqual([
        expect.objectContaining({ name: "counter", state: "online" }),
      ]);
      const stop = run(["ctl", "stop"], created.dir, { LOCALAPPDATA: local });
      expect(await stop.exited()).toBe(0);
      expect(await rack.exited()).toBe(0);
      expect(existsSync(paths.file)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved;
    }
  });
});
