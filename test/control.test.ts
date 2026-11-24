/**
 * Tests for the management endpoint and `rack ctl`: a Unix socket guarded by file permissions,
 * loopback TCP guarded by a token, and the operations of the rack handle behind both.
 *
 * @decision .agents/decisions/261117_005821-management-endpoint.md#transports
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-unix-socket
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-tcp-endpoint
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-protocol
 * @decision .agents/decisions/261117_005821-management-endpoint.md#the-command
 * @decision .agents/decisions/261118_015210-ci-with-windows.md#decision
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { type SlotStatus, slot } from "racku";
import { type ControlFile, controlPaths, controlTransport } from "../src/control.ts";
import {
  Cli,
  CONTROL_DIR,
  errorOf,
  FIXTURES,
  type TempApp,
  tempApp,
  useControlDir,
  useRacks,
} from "./fixtures/app.ts";

const startRack = useRacks();
useControlDir();

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
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const MANIFEST = `import { rack, slot } from "racku";

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

/**
 * Returns a function that posts an operation to the endpoint of the rack whose base directory is
 * `dir`, over the platform's default transport: the Unix socket, or on Windows loopback TCP with
 * the token from the control file. The file is read here, so each post goes out at once.
 *
 * @decision .agents/decisions/261118_015204-windows.md#changes-to-the-repository-and-the-tests
 */
async function endpointOf(
  dir: string,
): Promise<(op: string, args: unknown[]) => Promise<Response>> {
  const paths = controlPaths(dir);
  if (!WINDOWS) {
    return (op, args) =>
      fetch(`http://localhost/v1/${op}`, {
        method: "POST",
        unix: paths.socket,
        body: JSON.stringify({ args }),
      });
  }
  const { url, token } = (await Bun.file(paths.file).json()) as ControlFile;
  return (op, args) =>
    fetch(`${url}/v1/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ args }),
    });
}

describe.skipIf(WINDOWS)("the Unix socket", () => {
  // README.md, "Managing a running rack".
  // @doc docs/guides/managing.md#rack-ctl
  // @doc docs/guides/managing.md#who-can-connect
  // @doc docs/reference/reports.md#events
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
  test("rack start opens a socket only its user can use, and rack ctl operates the rack through it", async () => {
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

    // The feed holds the start and the restart, numbered from 1 without gaps.
    const events = run(["ctl", "events"], created.dir);
    expect(await events.exited()).toBe(0);
    const records = JSON.parse(events.output) as { seq: number }[];
    expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index + 1));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "log", message: "rack ctl started" }),
        expect.objectContaining({ type: "swap", device: "counter", mode: "restart" }),
      ]),
    );
    const newest = records.at(-1) as { seq: number };
    const after = run(["ctl", "events", "--after", String(newest.seq - 1)], created.dir);
    expect(await after.exited()).toBe(0);
    expect(JSON.parse(after.output)[0]).toEqual(newest);

    const stop = run(["ctl", "stop"], created.dir);
    expect(await stop.exited()).toBe(0);
    expect(await rack.exited()).toBe(0);
    expect(existsSync(paths.socket)).toBe(false);
  });

  // @doc docs/guides/managing.md#who-can-connect
  test("a stale socket is replaced, and a second rack refuses to start while one answers", async () => {
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

  // README.md, "Managing a running rack". macOS's temporary directories are such paths: /var is a
  // symlink to /private/var.
  // @doc docs/guides/managing.md#rack-ctl
  test("rack ctl finds the rack when the two reach its base directory by different paths, such as a symlink", async () => {
    const created = await app();
    const link = `${created.dir}-link`;
    await symlink(created.dir, link);
    try {
      // The rack gets its base directory through the link; rack ctl run inside it, the real path.
      const rack = run(["start", join(link, "rack.ts")], FIXTURES);
      await rack.waitFor(/control listening/);
      const inside = run(["ctl", "status"], created.dir);
      expect(await inside.exited()).toBe(0);
      expect(JSON.parse(inside.output)).toEqual([expect.objectContaining({ name: "counter" })]);
      const stop = run(["ctl", "stop", "--dir", link], FIXTURES);
      expect(await stop.exited()).toBe(0);
      expect(await rack.exited()).toBe(0);
    } finally {
      await unlink(link);
    }
  });
});

// @doc docs/guides/managing.md#who-can-connect
describe("the TCP endpoint", () => {
  test("the TCP endpoint takes requests only with the token, and refuses requests a web page sends", async () => {
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
    // A name that every object has is no operation either.
    expect((await post("constructor", { args: [] })).status).toBe(404);
    // Only Bearer <token> authenticates, not the token alone.
    expect((await post("status", { args: [] }, { authorization: token })).status).toBe(401);
    expect((await post("status", "not json")).status).toBe(400);
    expect((await post("swap", { args: [] })).status).toBe(400);
    expect(await (await post("swap", { args: ["ghost"] })).json()).toEqual({
      ok: false,
      error: { code: "RACK_NO_ROUTE", message: "no device named ghost" },
    });
    await running.stop();
    expect(existsSync(paths.file)).toBe(false);
  });

  // @doc docs/reference/cli.md#flags-of-rack-ctl
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
  test("RACK_CONTROL_TOKEN sets the token, and rack ctl reaches a rack by --url with it or --token-file", async () => {
    const created = await app();
    const secret = "s".repeat(40);
    const rack = run(["start", "--control-port", "0"], created.dir, { RACK_CONTROL_TOKEN: secret });
    await rack.waitFor(/control listening/);
    const { url, token } = (await Bun.file(controlPaths(created.dir).file).json()) as ControlFile;
    expect(token).toBe(secret);
    const byEnv = run(["ctl", "status", "--url", url], FIXTURES, { RACK_CONTROL_TOKEN: secret });
    expect(await byEnv.exited()).toBe(0);
    expect(JSON.parse(byEnv.output)[0]).toMatchObject({ name: "counter" });
    // The token file's first line is the token.
    await created.write("token", `${secret}\nthe rest is ignored\n`);
    const byFile = run(
      ["ctl", "status", "--url", url, "--token-file", join(created.dir, "token")],
      FIXTURES,
    );
    expect(await byFile.exited()).toBe(0);
    await created.write("wrong", `${"w".repeat(40)}\n`);
    const wrong = run(
      ["ctl", "status", "--url", url, "--token-file", join(created.dir, "wrong")],
      FIXTURES,
    );
    expect(await wrong.exited()).toBe(1);
    expect(wrong.output).toContain("the rack answered 401");
    const none = run(["ctl", "status", "--url", url], FIXTURES, { RACK_CONTROL_TOKEN: "" });
    expect(await none.exited()).toBe(1);
    // No token goes on the command line, where every user on the machine can read it.
    const flag = run(["ctl", "status", "--url", url, "--token", secret], FIXTURES);
    expect(await flag.exited()).toBe(2);
    expect(flag.output).toContain("--token-file <file>");
  });

  // @doc docs/guides/managing.md#who-can-connect
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
  test("a token of fewer than 32 characters, an empty one included, fails the start, naming its source", async () => {
    const created = await app();
    const spec = { slots: { 1: slot("./devices/counter.ts") } };
    const short = await errorOf(
      startRack(spec, { baseDir: created.dir, control: { port: 0, token: "x".repeat(31) } }),
    );
    expect([short.code, short.message]).toEqual([
      "RACK_MANIFEST",
      "the management endpoint's token from control.token has 31 characters; it needs 32 or more",
    ]);
    const empty = run(["start", "--control-port", "0"], created.dir, { RACK_CONTROL_TOKEN: "" });
    expect(await empty.exited()).toBe(1);
    expect(empty.output).toContain(
      "the management endpoint's token from RACK_CONTROL_TOKEN has 0 characters; it needs 32 or more",
    );
    expect(existsSync(controlPaths(created.dir).file)).toBe(false);
  });

  // @doc docs/reference/cli.md#flags-of-rack-ctl
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
  test("rack ctl sends a control file's token only while the process that the file names runs", async () => {
    const created = await app();
    const paths = controlPaths(created.dir);
    // What listens on the port of a rack that ended, such as another user's program.
    const heard: (string | null)[] = [];
    const taker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        heard.push(request.headers.get("authorization"));
        return Response.json({ ok: true, value: [] });
      },
    });
    try {
      const ended = Bun.spawn([process.execPath, "-e", ""]);
      await ended.exited;
      const file: ControlFile = { url: taker.url.origin, token: "t".repeat(43), pid: ended.pid };
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      await Bun.write(paths.file, JSON.stringify(file));
      if (!WINDOWS) await unlink(paths.socket).catch(() => undefined);
      const ctl = run(["ctl", "status"], created.dir);
      expect(await ctl.exited()).toBe(1);
      // rack ctl names the directory where it runs by its real path, as macOS gives it.
      expect(ctl.output).toContain(
        `no running rack has the base directory ${realpathSync(created.dir)}`,
      );
      expect(heard).toEqual([]);
    } finally {
      await taker.stop(true);
      await unlink(paths.file).catch(() => undefined);
    }
  });
});

// @doc docs/guides/managing.md#who-can-connect
describe("transports by platform", () => {
  test("Linux and macOS default to the Unix socket, and Windows and --control-port to TCP", () => {
    expect(controlTransport(undefined, "linux")).toBe("unix");
    expect(controlTransport(undefined, "darwin")).toBe("unix");
    expect(controlTransport(undefined, "win32")).toBe("tcp");
    expect(controlTransport(0, "linux")).toBe("tcp");
  });

  // @doc docs/reference/cli.md#environment-variables
  test("the control file lives in the user's own state directory, never in the app", () => {
    const saved = {
      local: process.env.LOCALAPPDATA,
      runtime: process.env.XDG_RUNTIME_DIR,
      state: process.env.XDG_STATE_HOME,
    };
    try {
      process.env.LOCALAPPDATA = "C:\\Users\\ada\\AppData\\Local";
      expect(controlPaths("/app", "win32").dir).toContain("racku");
      expect(controlPaths("/app", "win32").dir.startsWith(process.env.LOCALAPPDATA)).toBe(true);
      process.env.XDG_RUNTIME_DIR = "/run/user/1000";
      expect(controlPaths("/app", "linux").dir).toBe("/run/user/1000/racku");
      delete process.env.XDG_RUNTIME_DIR;
      process.env.XDG_STATE_HOME = "/var/state/ada";
      expect(controlPaths("/app", "linux").dir).toBe("/var/state/ada/racku/control");
      delete process.env.XDG_STATE_HOME;
      expect(controlPaths("/app", "linux").dir).toContain(".local/state/racku/control");
      expect(controlPaths("/app", "linux").socket).not.toContain("/app/");
      // An empty or relative variable counts as unset, so the endpoint never lands where the
      // rack happens to start.
      // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
      for (const value of ["", "relative/run"]) {
        process.env.XDG_RUNTIME_DIR = value;
        process.env.XDG_STATE_HOME = value;
        expect(controlPaths("/app", "linux").dir).toBe(
          posix.join(homedir(), ".local", "state", "racku", "control"),
        );
        process.env.LOCALAPPDATA = value;
        expect(controlPaths("/app", "win32").dir).toBe(
          win32.join(homedir(), "AppData", "Local", "racku", "control"),
        );
      }
    } finally {
      if (saved.local === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved.local;
      if (saved.state === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved.state;
      process.env.XDG_RUNTIME_DIR = saved.runtime ?? CONTROL_DIR;
    }
  });
});

// @doc docs/guides/managing.md#who-can-connect
// @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
describe.skipIf(WINDOWS)("a private control directory", () => {
  const spec = { slots: { 1: slot("./devices/counter.ts") } };
  /** Runs `body` with the control directory under a runtime directory of its own. */
  async function withRuntime(body: (runtime: string) => Promise<void>): Promise<void> {
    const runtime = await mkdtemp(join(tmpdir(), "racku-runtime-"));
    process.env.XDG_RUNTIME_DIR = runtime;
    try {
      await body(runtime);
    } finally {
      process.env.XDG_RUNTIME_DIR = CONTROL_DIR;
      await rm(runtime, { recursive: true, force: true });
    }
  }

  test("a control directory that is a link fails the start", async () => {
    const created = await app();
    await withRuntime(async (runtime) => {
      const elsewhere = join(runtime, "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await symlink(elsewhere, join(runtime, "racku"));
      const failed = await errorOf(startRack(spec, { baseDir: created.dir, control: true }));
      expect([failed.code, failed.message]).toEqual([
        "RACK_MANIFEST",
        expect.stringContaining(
          `the control directory ${join(runtime, "racku")} is a symbolic link`,
        ),
      ]);
    });
  });

  test("a control directory of another user fails the start", async () => {
    const created = await app();
    const own = process.getuid?.() as number;
    const getuid = process.getuid;
    await withRuntime(async (runtime) => {
      // The rack sees itself as another user, as when someone else made the directory first.
      process.getuid = () => own + 1;
      try {
        const failed = await errorOf(startRack(spec, { baseDir: created.dir, control: true }));
        expect([failed.code, failed.message]).toEqual([
          "RACK_MANIFEST",
          expect.stringContaining(`${join(runtime, "racku")} belongs to the user ${own}`),
        ]);
      } finally {
        process.getuid = getuid;
      }
    });
  });

  test("an earlier rack's socket that accepts but doesn't answer within 5 s fails the start", async () => {
    const created = await app();
    await withRuntime(async () => {
      const paths = controlPaths(created.dir);
      await mkdir(paths.dir, { recursive: true, mode: 0o700 });
      // Accepts every connection, and never answers.
      const silent = Bun.listen({ unix: paths.socket, socket: { data() {} } });
      try {
        const started = performance.now();
        const failed = await errorOf(startRack(spec, { baseDir: created.dir, control: true }));
        expect([failed.code, failed.message]).toEqual([
          "RACK_MANIFEST",
          `a process accepted on ${paths.socket} but didn't answer within 5 s; stop it before starting this rack`,
        ]);
        expect(performance.now() - started).toBeGreaterThan(4_500);
      } finally {
        silent.stop(true);
      }
    });
  }, 15_000);
});

// @doc docs/guides/managing.md#the-protocol
describe("the protocol", () => {
  test("operations from the endpoint and from code run one at a time, in call order", async () => {
    const created = await app();
    const { running } = await startRack(
      {
        slots: {
          1: slot("./devices/busy.ts", { config: { activateDelayMs: 150 } }),
        },
      },
      { baseDir: created.dir, control: true },
    );
    const post = await endpointOf(created.dir);
    const fromCode = running.swap("busy");
    const fromEndpoint = post("restart", ["busy"]);
    await fromCode;
    expect(((await (await fromEndpoint).json()) as { ok: boolean }).ok).toBe(true);
    expect(running.history().map((record) => record.cause)).toEqual(["restart", "swap"]);
  });

  test("plug takes its slot spec as { source, name, config }", async () => {
    const created = await app();
    const { running } = await startRack(
      { slots: { 1: slot("./devices/counter.ts") } },
      { baseDir: created.dir, control: true },
    );
    const post = await endpointOf(created.dir);
    const answer = await post("plug", [3, { source: "./devices/counter.ts", name: "second" }]);
    expect(await answer.json()).toEqual({ ok: true, value: null });
    expect(running.status().map((s) => s.name)).toEqual(["counter", "second"]);
  });

  // @doc docs/guides/managing.md#rack-ctl
  test("rack ctl reports when no rack runs for the directory", async () => {
    const created = await app();
    const ctl = run(["ctl", "status"], created.dir);
    expect(await ctl.exited()).toBe(1);
    expect(ctl.output).toContain("no running rack has the base directory");
  });
});

describe.skipIf(!WINDOWS)("Windows defaults", () => {
  // README.md, "Managing a running rack". Runs only in CI's Windows job.
  // @doc docs/guides/running.md#windows
  // @doc docs/guides/managing.md#who-can-connect
  test("on Windows, rack start listens on loopback TCP, writes its control file under %LOCALAPPDATA%, and rack ctl reaches it", async () => {
    const saved = process.env.LOCALAPPDATA;
    const local = join(CONTROL_DIR, "LocalAppData");
    process.env.LOCALAPPDATA = local;
    try {
      const created = await app();
      const rack = run(["start"], created.dir, { LOCALAPPDATA: local });
      await rack.waitFor(/control listening/);
      expect(rack.output).toMatch(/control listening .*http:\/\/127\.0\.0\.1:\d+/);
      const paths = controlPaths(created.dir);
      expect(paths.file.startsWith(join(local, "racku", "control"))).toBe(true);
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
