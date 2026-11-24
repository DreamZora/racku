/**
 * Tests for `rack dashboard`: the server that serves the dashboard's page on loopback, and
 * forwards the page's requests to the management endpoint of a running rack. Most tests spawn
 * `rack dashboard` and read its URL from its first line; the waits past the bounds use the
 * server's function in the test's process, with bounds that the test shortens.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#rack-dashboard
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-the-dashboard-forwards
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { type SlotStatus, slot } from "racku";
import type { RackTarget } from "../src/commands.ts";
import { type ControlFile, controlPaths } from "../src/control.ts";
import {
  BODY_LIMIT,
  type DashboardBounds,
  openDashboard,
  WAITING_LIMIT,
} from "../src/dashboard/server.ts";
import {
  Cli,
  CONTROL_DIR,
  FIXTURES,
  type TempApp,
  tempApp,
  useControlDir,
  useRacks,
  WINDOWS,
  waitFor,
} from "./fixtures/app.ts";

const startRack = useRacks();
useControlDir();

// The racks in the test's process use the runtime directory of the dashboards that it starts.
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
/** Stops what a test serves in its own process: stand-in endpoints and dashboards. */
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const MANIFEST = `import { rack, slot } from "racku";

export default rack("dash", { slots: { 1: slot("./devices/counter.ts") } });
`;

/** The rack of most tests: the counter alone. */
const SPEC = { slots: { 1: slot("./devices/counter.ts") } };

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

/** Where a test reaches a dashboard's API: its origin, and its token. */
interface Api {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  token: string;
}

/** A dashboard that `rack dashboard` runs, with what its first line says. */
interface Spawned extends Api {
  cli: Cli;
  /** What it watches: the base directory, or the URL. */
  target: string;
  /** The page's URL, with the token in its fragment. */
  url: string;
  port: number;
}

/** The line that `rack dashboard` prints first. */
const URL_LINE = /^dashboard of (.+) at (http:\/\/127\.0\.0\.1:(\d+)\/#token=([\w-]+))$/m;

/**
 * Runs `rack dashboard` with `args`, and waits for its URL. With `input: "console"`, it runs on a
 * console of its own on Windows, so that a test can stop it with Ctrl+C or Ctrl+Break.
 */
async function dashboard(
  args: string[],
  cwd = FIXTURES,
  env: Record<string, string> = {},
  input?: "console",
): Promise<Spawned> {
  const cli = new Cli(["dashboard", ...args], cwd, env, undefined, input);
  processes.push(cli);
  const [, target = "", url = "", port = "", token = ""] = await cli.waitFor(URL_LINE);
  return { cli, target, url, origin: new URL(url).origin, port: Number(port), token };
}

/** Opens a dashboard in the test's process, with the bounds given, and collects what it prints. */
function inProcess(
  target: RackTarget,
  bounds: Partial<DashboardBounds>,
): Api & { lines: string[] } {
  const lines: string[] = [];
  const opened = openDashboard({ target, port: 0, print: (line) => lines.push(line), bounds });
  closers.push(() => opened.stop());
  const url = new URL(opened.url);
  return { origin: url.origin, token: url.hash.slice("#token=".length), lines };
}

/** Posts an operation to a dashboard's API with its token, and the headers given. */
function api(
  on: Api,
  op: string,
  args: unknown[] = [],
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${on.origin}/api/v1/${op}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${on.token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ args }),
  });
}

/** An answer's status, and its body parsed, or `null` when it has none. */
async function answer(response: Response | Promise<Response>): Promise<[number, unknown]> {
  const received = await response;
  const text = await received.text();
  return [received.status, text === "" ? null : JSON.parse(text)];
}

/** The lines that a dashboard printed on standard output. */
function lines(cli: Cli): string[] {
  return cli.stdout.split("\n").filter((line) => line !== "");
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

/** What a stand-in endpoint heard of one request. */
interface Heard {
  path: string;
  body: string;
  headers: Headers;
}

/**
 * A stand-in for a rack's TCP endpoint, which `--url` reaches: it records each request, and
 * answers as `respond` says, by default `{ "ok": true, "value": [] }`.
 */
function stub(
  respond: (op: string) => Response | Promise<Response> = () =>
    Response.json({ ok: true, value: [] }),
): { url: string; heard: Heard[] } {
  const heard: Heard[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      heard.push({ path, body: await request.text(), headers: request.headers });
      return respond(path.slice("/v1/".length));
    },
  });
  closers.push(() => server.stop(true));
  return { url: server.url.origin, heard };
}

/** A token file in `created`, with `token` on its first line; its path. */
async function tokenFile(created: TempApp, token: string, name = "token"): Promise<string> {
  await created.write(name, `${token}\nthe rest is ignored\n`);
  return join(created.dir, name);
}

/** Sends one raw HTTP request, so that the test controls every header, Host included. */
async function raw(port: number, request: string): Promise<{ status: number; head: string }> {
  const text = await new Promise<string>((resolve, reject) => {
    let received = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          socket.write(request);
        },
        data: (_socket, chunk) => {
          received += chunk.toString();
        },
        close: () => resolve(received),
        error: (_socket, error) => reject(error),
      },
    }).catch(reject);
  });
  const head = text.slice(0, text.indexOf("\r\n\r\n")).toLowerCase();
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]), head };
}

/**
 * Whether a TCP connection to `hostname` and `port` opens. Unlike `fetch`, it goes through no
 * proxy that the environment names.
 */
async function connects(hostname: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    // Refused, or unreachable: nothing accepts there.
    return false;
  }
}

/** A `POST` of `status` with the token, whose `Host` and other headers the test writes. */
function rawStatus(token: string, host: string, more = ""): string {
  return `POST /api/v1/status HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${token}\r\n${more}Content-Length: 2\r\nConnection: close\r\n\r\n{}`;
}

describe("forwarding to a running rack", () => {
  // @doc docs/reference/cli.md#commands
  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  test("forwards each read and operation, answers with the rack's own answer, and prints each operation's outcome", async () => {
    const created = await app();
    const { running } = await startRack(SPEC, { baseDir: created.dir, control: true });
    const d = await dashboard(["--dir", created.dir]);
    expect(d.target).toBe(created.dir);

    expect(await answer(api(d, "status"))).toEqual([200, { ok: true, value: statusOf(running) }]);
    const [metricsStatus, metrics] = await answer(api(d, "metrics"));
    expect(metricsStatus).toBe(200);
    const devices = (metrics as { value: { devices: { device: string }[] } }).value.devices;
    expect(devices.map((device) => device.device)).toEqual(["counter"]);
    expect(await answer(api(d, "history"))).toEqual([200, { ok: true, value: [] }]);
    expect(await answer(api(d, "reload"))).toEqual([200, { ok: true, value: [] }]);

    const first = running.status()[0]?.firmware;
    const source = await created.read("devices/counter.ts");
    await created.write("devices/counter.ts", source.replace('"v1"', '"v2"'));
    expect(await answer(api(d, "swap", ["counter"]))).toEqual([200, { ok: true, value: null }]);
    expect(running.status()[0]?.firmware).not.toBe(first);
    const [rolledStatus, rolled] = await answer(api(d, "rollback", ["counter"]));
    expect([rolledStatus, (rolled as { ok: boolean }).ok]).toEqual([200, true]);
    expect(running.status()[0]?.firmware).toBe(first);
    // A failed operation still answers 200, with the rack's error.
    const [failedStatus, failed] = await answer(
      api(d, "rollback", ["counter", { to: "nonexistent" }]),
    );
    expect(failedStatus).toBe(200);
    expect(failed).toEqual({
      ok: false,
      error: { code: "RACK_SWAP_REJECTED", message: expect.any(String) },
    });
    const [restartStatus, restarted] = await answer(
      api(d, "restart", ["counter", { cascade: false }]),
    );
    expect(restartStatus).toBe(200);
    expect(restarted).toEqual({
      ok: true,
      value: [expect.objectContaining({ device: "counter", mode: "restart" })],
    });
    const [, history] = await answer(api(d, "history", ["counter"]));
    expect((history as { value: { cause: string }[] }).value.map((record) => record.cause)).toEqual(
      ["restart", "rollback", "rollback", "swap"],
    );

    expect(await answer(api(d, "stop"))).toEqual([200, { ok: true, value: null }]);
    // The rack stops once its answer has gone out.
    const none = JSON.stringify([
      502,
      { error: `no running rack has the base directory ${created.dir}` },
    ]);
    await waitFor(async () => JSON.stringify(await answer(api(d, "status"))) === none);
    const printed = lines(d.cli);
    expect(printed.slice(0, 7)).toEqual([
      `dashboard of ${created.dir} at ${d.url}`,
      "reload: ok",
      "swap counter: ok",
      "rollback counter: ok",
      `rollback counter {"to":"nonexistent"}: RACK_SWAP_REJECTED: ${(failed as { error: { message: string } }).error.message}`,
      'restart counter {"cascade":false}: ok',
      "stop: ok",
    ]);
    // Once the rack has stopped, a line says that it doesn't answer, and why.
    expect(printed[7]).toStartWith("the rack doesn't answer: ");
    expect(printed.length).toBe(8);
  }, 30_000);

  test("refuses plug, unplug, a swap to another device file, and arguments that an operation doesn't take", async () => {
    const created = await app();
    const { running } = await startRack(SPEC, { baseDir: created.dir, control: true });
    const d = await dashboard(["--dir", created.dir]);
    const refused: [string, unknown[], number][] = [
      ["plug", [3, { source: "./devices/counter.ts", name: "second" }], 404],
      ["unplug", ["counter"], 404],
      ["swap", ["counter", "./devices/counter.ts"], 400],
      ["swap", [], 400],
      ["swap", [{ name: "counter" }], 400],
      ["restart", ["counter", "--no-cascade"], 400],
      ["restart", ["counter", {}, {}], 400],
      ["rollback", [["counter"]], 400],
      ["history", [1], 400],
      ["history", ["counter", "again"], 400],
      ["events", [1, 2], 400],
      ["status", ["counter"], 400],
      ["about", [true], 400],
      ["explode", [], 404],
      // A name that every object has is no operation either.
      ["constructor", [], 404],
    ];
    for (const [op, args, status] of refused) {
      const [got, body] = await answer(api(d, op, args));
      expect([op, got]).toEqual([op, status]);
      expect(body).toEqual({ error: expect.any(String) });
    }
    const post = (path: string, body: string) =>
      fetch(`${d.origin}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${d.token}` },
        body,
      });
    expect((await post("/api/v1/Status", "{}")).status).toBe(404);
    expect((await post("/api/v2/status", "{}")).status).toBe(404);
    expect((await post("/api/v1/status/now", "{}")).status).toBe(404);
    for (const body of ["", "not json", "[]", '{"args":{}}', '{"args":null}', '{"args":"a"}']) {
      expect([body, (await post("/api/v1/status", body)).status]).toEqual([body, 400]);
    }
    // Without args, an operation has none.
    expect((await post("/api/v1/status", "{}")).status).toBe(200);
    // Nothing reached the rack's queue, and the dashboard printed no operation.
    expect(running.history()).toEqual([]);
    expect(running.status().map((device) => device.name)).toEqual(["counter"]);
    expect(lines(d.cli)).toEqual([`dashboard of ${created.dir} at ${d.url}`]);
  }, 30_000);

  test("forwards an operation as the endpoint takes it, with the token of --url, and passes the answer on unchanged", async () => {
    const created = await app();
    const rackToken = "r".repeat(43);
    const answers: Record<string, () => Response> = {
      events: () =>
        new Response('{ "ok": true, "value": [ { "seq": 4, "type": "log" } ] }', {
          headers: { "content-type": "application/json" },
        }),
      restart: () =>
        Response.json({
          ok: false,
          error: { code: "COUNTER_FAILED", message: "first line\n[rack] forged line" },
        }),
    };
    /** Answers that no rack's endpoint gives, once the test sets `breaking`. */
    const broken: Record<string, () => Response> = {
      metrics: () => new Response("not json", { headers: { "content-type": "application/json" } }),
      history: () => Response.json({ ok: "maybe" }),
      reload: () => new Response("broken", { status: 500 }),
    };
    let breaking = false;
    const endpoint = stub(
      (op) => (breaking ? broken[op] : answers[op])?.() ?? Response.json({ ok: true, value: null }),
    );
    const d = await dashboard([
      "--url",
      endpoint.url,
      "--token-file",
      await tokenFile(created, rackToken),
    ]);
    expect(d.target).toBe(endpoint.url);
    expect(await answer(api(d, "about"))).toEqual([
      200,
      { ok: true, value: { target: endpoint.url } },
    ]);
    expect(endpoint.heard).toEqual([]);

    // What the page sent beyond the operation stays with the dashboard.
    const events = await fetch(`${d.origin}/api/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${d.token}`,
        origin: d.origin,
        "sec-fetch-site": "same-origin",
        cookie: "session=1",
      },
      body: JSON.stringify({ args: [3], extra: "dropped" }),
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toBe("application/json");
    expect(await events.text()).toBe('{ "ok": true, "value": [ { "seq": 4, "type": "log" } ] }');
    const [heard] = endpoint.heard;
    expect(heard?.path).toBe("/v1/events");
    expect(heard?.body).toBe('{"args":[3]}');
    expect(heard?.headers.get("authorization")).toBe(`Bearer ${rackToken}`);
    expect(heard?.headers.get("host")).toBe(new URL(endpoint.url).host);
    for (const header of ["origin", "cookie", "sec-fetch-site"]) {
      expect([header, heard?.headers.get(header)]).toEqual([header, null]);
    }

    const forwarded: [string, unknown[]][] = [
      ["status", []],
      ["history", ["counter"]],
      ["events", []],
      ["swap", ["counter"]],
      ["restart", ["counter"]],
      ["rollback", ["counter", { to: "abc" }]],
      ["stop", []],
    ];
    for (const [op, args] of forwarded) await api(d, op, args);
    expect(endpoint.heard.slice(1).map(({ path, body }) => [path, JSON.parse(body).args])).toEqual(
      forwarded.map(([op, args]) => [`/v1/${op}`, args]),
    );
    // An answer that isn't the endpoint's, or an HTTP error, is no answer.
    breaking = true;
    expect(await answer(api(d, "metrics"))).toEqual([
      502,
      { error: "the answer isn't the JSON of a rack's management endpoint" },
    ]);
    expect((await api(d, "history")).status).toBe(502);
    expect(await answer(api(d, "reload"))).toEqual([
      502,
      { error: "the rack answered 500 Internal Server Error" },
    ]);
    await d.cli.waitFor(/^reload: the rack answered 500/m);
    expect(lines(d.cli).slice(1)).toEqual([
      "swap counter: ok",
      // The message's newline can't start a line of its own.
      "restart counter: COUNTER_FAILED: first line\\n[rack] forged line",
      'rollback counter {"to":"abc"}: ok',
      "stop: ok",
      "the rack doesn't answer: the answer isn't the JSON of a rack's management endpoint",
      "reload: the rack answered 500 Internal Server Error",
    ]);
  }, 30_000);
});

describe("who can use the dashboard", () => {
  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  test("answers 401 to a token that is missing, wrong, bare, or of an earlier start, and sends no CORS headers", async () => {
    const endpoint = stub();
    const created = await app();
    const file = await tokenFile(created, "t".repeat(43));
    const d = await dashboard(["--url", endpoint.url, "--token-file", file]);
    const post = (authorization?: string) =>
      fetch(`${d.origin}/api/v1/status`, {
        method: "POST",
        headers: authorization === undefined ? {} : { authorization },
        body: "{}",
      });
    const missing = await post();
    expect([missing.status, await missing.text()]).toEqual([401, ""]);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await post("Bearer wrong")).status).toBe(401);
    // Only Bearer <token> authenticates, not the token alone.
    expect((await post(d.token)).status).toBe(401);
    expect((await post(`bearer ${d.token}`)).status).toBe(401);
    expect((await post(`Bearer ${d.token}x`)).status).toBe(401);
    // Each start has a token of its own.
    const again = await dashboard(["--url", endpoint.url, "--token-file", file]);
    expect(again.token).not.toBe(d.token);
    expect(d.token).toHaveLength(43);
    expect((await api({ origin: again.origin, token: d.token }, "status")).status).toBe(401);
    const ok = await post(`Bearer ${d.token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(endpoint.heard).toHaveLength(1);
    for (const response of [missing, ok]) {
      const cors = [...response.headers.keys()].filter((name) => name.startsWith("access-control"));
      expect(cors).toEqual([]);
    }
  }, 30_000);

  test("answers 403 to a foreign Host, Origin, or Sec-Fetch-Site, which only another site's page sends", async () => {
    const endpoint = stub();
    const created = await app();
    const d = await dashboard([
      "--url",
      endpoint.url,
      "--token-file",
      await tokenFile(created, "t".repeat(43)),
    ]);
    const forbidden: Record<string, string>[] = [
      { origin: "https://example.com" },
      { origin: `http://127.0.0.1:${d.port + 1}` },
      { origin: `https://127.0.0.1:${d.port}` },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
    ];
    for (const headers of forbidden) {
      const response = await api(d, "status", [], headers);
      expect([headers, response.status, await response.text()]).toEqual([headers, 403, ""]);
    }
    // What the page itself sends.
    const own = { origin: d.origin, "sec-fetch-site": "same-origin" };
    expect((await api(d, "status", [], own)).status).toBe(200);

    // A site that points its domain name at 127.0.0.1 still sends its own name as Host.
    for (const host of [
      `rebound.example:${d.port}`,
      `127.0.0.1.nip.io:${d.port}`,
      `localhost.:${d.port}`,
    ]) {
      expect([host, (await raw(d.port, rawStatus(d.token, host))).status]).toEqual([host, 403]);
    }
    // Loopback's names pass with any port, so that a port forward works.
    for (const host of [`127.0.0.1:${d.port}`, "localhost:8080", "[::1]:8080", "127.0.0.1"]) {
      expect([host, (await raw(d.port, rawStatus(d.token, host))).status]).toEqual([host, 200]);
    }
    // The Origin must match the Host the request came with.
    const mismatched = rawStatus(d.token, "localhost:8080", `Origin: http://127.0.0.1:8080\r\n`);
    expect((await raw(d.port, mismatched)).status).toBe(403);
    const matched = rawStatus(d.token, "localhost:8080", `Origin: http://localhost:8080\r\n`);
    expect((await raw(d.port, matched)).status).toBe(200);
    // A preflight gets no CORS headers.
    const preflight = await raw(
      d.port,
      `OPTIONS /api/v1/status HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nOrigin: https://example.com\r\nAccess-Control-Request-Method: POST\r\nConnection: close\r\n\r\n`,
    );
    expect(preflight.status).toBe(403);
    expect(preflight.head).not.toContain("access-control");
    // Only the requests that passed reached the rack.
    expect(endpoint.heard).toHaveLength(6);
  }, 30_000);

  test("answers 405 to methods other than POST, and 413 to a body over 64 KiB", async () => {
    const endpoint = stub();
    const created = await app();
    const d = await dashboard([
      "--url",
      endpoint.url,
      "--token-file",
      await tokenFile(created, "t".repeat(43)),
    ]);
    const headers = { authorization: `Bearer ${d.token}` };
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(`${d.origin}/api/v1/status`, { method, headers });
      expect([method, response.status]).toEqual([method, 405]);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(BODY_LIMIT).toBe(64 * 1024);
    // The largest body that it takes: { "args": [] } with spaces up to 64 KiB.
    const largest = `{"args":[]${" ".repeat(BODY_LIMIT - 11)}}`;
    expect(largest).toHaveLength(BODY_LIMIT);
    const post = (body: string | ReadableStream<Uint8Array>) =>
      fetch(`${d.origin}/api/v1/status`, { method: "POST", headers, body });
    expect((await post(largest)).status).toBe(200);
    const declared = await post(`${largest} `);
    expect([declared.status, (await declared.json()) as unknown]).toEqual([
      413,
      { error: expect.any(String) },
    ]);
    // A body without a length counts by its bytes.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"args":[]${" ".repeat(40_000)}`));
        controller.enqueue(new TextEncoder().encode(`${" ".repeat(40_000)}}`));
        controller.close();
      },
    });
    expect((await post(chunked)).status).toBe(413);
    expect(endpoint.heard).toHaveLength(1);
  }, 30_000);
});

describe("bounds", () => {
  test(`lets ${WAITING_LIMIT} requests wait for the rack, and answers 503 to more until one ends`, async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = stub(async () => {
      await gate;
      return Response.json({ ok: true, value: [] });
    });
    const created = await app();
    const d = await dashboard([
      "--url",
      endpoint.url,
      "--token-file",
      await tokenFile(created, "t".repeat(43)),
    ]);
    expect(WAITING_LIMIT).toBe(16);
    const waiting = Array.from({ length: WAITING_LIMIT }, () => api(d, "status"));
    await waitFor(() => endpoint.heard.length === WAITING_LIMIT);
    expect(await answer(api(d, "status"))).toEqual([503, { error: expect.any(String) }]);
    expect((await api(d, "reload")).status).toBe(503);
    // The dashboard's own operation waits for no rack.
    expect((await api(d, "about")).status).toBe(200);
    release();
    for (const response of await Promise.all(waiting)) expect(response.status).toBe(200);
    expect((await api(d, "status")).status).toBe(200);
    expect(endpoint.heard).toHaveLength(WAITING_LIMIT + 1);
  }, 30_000);

  test("answers 504 when the rack doesn't answer a read or an operation within its bound", async () => {
    // Accepts every request, and answers none; history sends its headers, and holds its body.
    const endpoint = stub((op) =>
      op === "history"
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"ok":'));
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        : new Promise<Response>(() => {}),
    );
    const d = inProcess(
      { url: endpoint.url, token: "t".repeat(43) },
      { read: 300, operation: 2_000 },
    );
    let started = performance.now();
    expect(await answer(api(d, "status"))).toEqual([
      504,
      { error: "the rack didn't answer status within 0.3 s" },
    ]);
    const read = performance.now() - started;
    expect(read).toBeGreaterThanOrEqual(250);
    expect(read).toBeLessThan(2_000);
    started = performance.now();
    expect(await answer(api(d, "history"))).toEqual([
      504,
      { error: "the rack didn't answer history within 0.3 s" },
    ]);
    expect(performance.now() - started).toBeLessThan(2_000);
    started = performance.now();
    expect(await answer(api(d, "reload"))).toEqual([
      504,
      {
        error:
          "the rack didn't answer reload within 2 s; it may still run, and the history will show its outcome",
      },
    ]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_950);
    expect(d.lines).toEqual([
      "the rack doesn't answer: the rack didn't answer status within 0.3 s",
      "reload: the rack didn't answer reload within 2 s; it may still run, and the history will show its outcome",
    ]);
  }, 15_000);

  test("answers 504 to metrics while a device hangs past the bound, and status at once", async () => {
    const created = await app();
    const { running } = await startRack(SPEC, {
      baseDir: created.dir,
      control: true,
      faultInjection: true,
      hookTimeout: 3_000,
    });
    const short = inProcess({ dir: created.dir }, { read: 500 });
    const long = inProcess({ dir: created.dir }, { read: 10_000 });
    await running.injectFault("counter", "hang");
    // The hang begins once the Worker has answered.
    await Bun.sleep(100);
    const started = performance.now();
    expect(await answer(api(short, "metrics"))).toEqual([
      504,
      { error: "the rack didn't answer metrics within 0.5 s" },
    ]);
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(await answer(api(short, "status"))).toEqual([
      200,
      { ok: true, value: statusOf(running) },
    ]);
    // Past hookTimeout, the rack answers without the device that hangs.
    const [status, metrics] = await answer(api(long, "metrics"));
    expect(status).toBe(200);
    expect((metrics as { value: { devices: unknown[] } }).value.devices).toEqual([]);
  }, 20_000);
});

describe("the rack it watches", () => {
  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  test("starts while no rack runs, and follows a rack that starts, stops, and starts again for its base directory", async () => {
    const created = await app();
    // From the rack's directory, which names it by its real path, as macOS gives it.
    const dir = realpathSync(created.dir);
    const d = await dashboard([], created.dir);
    expect(d.target).toBe(dir);
    const none = { error: `no running rack has the base directory ${dir}` };
    expect(await answer(api(d, "status"))).toEqual([502, none]);
    expect(await answer(api(d, "about"))).toEqual([200, { ok: true, value: { target: dir } }]);
    const first = await startRack(SPEC, { baseDir: created.dir, control: true });
    expect(await answer(api(d, "status"))).toEqual([
      200,
      { ok: true, value: statusOf(first.running) },
    ]);
    await first.running.stop();
    expect(await answer(api(d, "status"))).toEqual([502, none]);
    const second = await startRack(SPEC, { baseDir: created.dir, control: true });
    expect(await answer(api(d, "status"))).toEqual([
      200,
      { ok: true, value: statusOf(second.running) },
    ]);
    await d.cli.waitFor(/^the rack answers\n(?:.*\n)*the rack answers$/m);
    expect(lines(d.cli)).toEqual([
      `dashboard of ${dir} at ${d.url}`,
      `the rack doesn't answer: ${none.error}`,
      "the rack answers",
      `the rack doesn't answer: ${none.error}`,
      "the rack answers",
    ]);
  }, 30_000);

  test("answers 502 once the rack's process crashes, and reaches the rack that starts in its place", async () => {
    const created = await app();
    const first = run(["start"], created.dir);
    await first.waitFor(/control listening/);
    const d = await dashboard(["--dir", created.dir]);
    expect((await api(d, "status")).status).toBe(200);
    // Killed, the process leaves its socket or control file behind.
    await first.stop();
    const [status, body] = await answer(api(d, "status"));
    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(
      /^(cannot reach the rack: |no running rack has the base directory )/,
    );
    const second = run(["start"], created.dir);
    await second.waitFor(/control listening/);
    const [again, devices] = await answer(api(d, "status"));
    expect(again).toBe(200);
    expect((devices as { value: SlotStatus[] }).value.map((device) => device.name)).toEqual([
      "counter",
    ]);
    await d.cli.waitFor(/^the rack answers$/m);
    expect(lines(d.cli).slice(1)).toEqual([
      `the rack doesn't answer: ${(body as { error: string }).error}`,
      "the rack answers",
    ]);
  }, 30_000);

  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  // @doc docs/reference/cli.md#exit-codes
  test("reaches a TCP endpoint by --url with its token, and answers 502 naming the rack's 401 to a wrong one", async () => {
    const created = await app();
    const { running } = await startRack(SPEC, { baseDir: created.dir, control: { port: 0 } });
    const { url, token } = (await Bun.file(controlPaths(created.dir).file).json()) as ControlFile;
    const byFile = await dashboard(["--url", url, "--token-file", await tokenFile(created, token)]);
    expect(byFile.target).toBe(url);
    expect(await answer(api(byFile, "status"))).toEqual([
      200,
      { ok: true, value: statusOf(running) },
    ]);
    expect(await answer(api(byFile, "about"))).toEqual([200, { ok: true, value: { target: url } }]);
    const byEnv = await dashboard(["--url", url], FIXTURES, { RACK_CONTROL_TOKEN: token });
    expect((await api(byEnv, "status")).status).toBe(200);

    const wrong = await dashboard([
      "--url",
      url,
      "--token-file",
      await tokenFile(created, "w".repeat(43), "wrong"),
    ]);
    const refused = { error: "the rack answered 401 Unauthorized" };
    expect(await answer(api(wrong, "status"))).toEqual([502, refused]);
    await wrong.cli.waitFor(/the rack doesn't answer/);
    expect(lines(wrong.cli).slice(1)).toEqual([`the rack doesn't answer: ${refused.error}`]);

    // The rack's token goes to the rack alone, never to a proxy that the environment names.
    // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-management-endpoint-and-rack-ctl
    const proxied: string[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        proxied.push(request.url);
        return new Response(null, { status: 502 });
      },
    });
    closers.push(() => proxy.stop(true));
    const through = `http://127.0.0.1:${proxy.port}`;
    const direct = await dashboard(["--url", url], FIXTURES, {
      RACK_CONTROL_TOKEN: token,
      HTTP_PROXY: through,
      http_proxy: through,
      NO_PROXY: "",
      no_proxy: "",
    });
    expect((await api(direct, "status")).status).toBe(200);
    expect(proxied).toEqual([]);

    // A token file that it can't read keeps it from starting.
    const unreadable = run(
      ["dashboard", "--url", url, "--token-file", join(created.dir, "missing")],
      FIXTURES,
    );
    expect(await unreadable.exited()).toBe(1);
    expect(unreadable.output).toContain(
      `cannot read the token file ${join(created.dir, "missing")}`,
    );
    expect(unreadable.stdout).toBe("");
  }, 30_000);
});

describe("the command", () => {
  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  test("listens on 127.0.0.1 only, on the --port given", async () => {
    const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = free.port as number;
    await free.stop(true);
    const d = await dashboard(["--dir", FIXTURES, "--port", String(port)]);
    expect(d.port).toBe(port);
    expect(await connects("127.0.0.1", port)).toBe(true);
    // Nothing accepts on the port at the machine's other addresses.
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((info) => info !== undefined && !info.internal && info.family === "IPv4")
      .map((info) => info?.address as string);
    for (const host of ["::1", ...others]) {
      expect([host, await connects(host, port)]).toEqual([host, false]);
    }
  }, 30_000);

  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  // @doc docs/reference/cli.md#exit-codes
  test("exits with code 1, naming the port, when --port is taken", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    closers.push(() => taken.stop(true));
    const cli = run(["dashboard", "--port", String(taken.port)], FIXTURES);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain(`rack: cannot listen on 127.0.0.1:${taken.port}`);
    expect(cli.stdout).toBe("");
  });

  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  // @doc docs/reference/cli.md#exit-codes
  test("exits with code 2 for a wrong command line", async () => {
    const wrong = [
      ["--port", "http"],
      ["--port", "65536"],
      ["--port", "-1"],
      ["--port", "1.5"],
      ["--token-file", "token"],
      ["--url", "http://127.0.0.1:1", "--dir", FIXTURES],
      ["--url", "not a url"],
      ["--url", "ftp://127.0.0.1:1"],
      ["--token", "t".repeat(43)],
      ["status"],
    ];
    const runs = wrong.map((args) => run(["dashboard", ...args], FIXTURES));
    for (const [index, cli] of runs.entries()) {
      expect([wrong[index], await cli.exited()]).toEqual([wrong[index], 2]);
      expect(cli.output).toContain("rack dashboard [--dir <base directory>] [--port <port>]");
      expect(cli.stdout).toBe("");
    }
  }, 30_000);

  // Windows has no SIGTERM.
  // @decision .agents/decisions/261118_015204-windows.md#differences-the-readme-states
  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  // @doc docs/reference/cli.md#exit-codes
  test.skipIf(WINDOWS)("closes on SIGTERM with code 0", async () => {
    const d = await dashboard(["--dir", FIXTURES]);
    d.cli.kill("SIGTERM");
    expect(await d.cli.exited()).toBe(0);
    expect(lines(d.cli)).toEqual([`dashboard of ${FIXTURES} at ${d.url}`]);
  });

  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  // @doc docs/reference/cli.md#exit-codes
  test("closes on SIGINT with code 0, and prints the token in its URL alone", async () => {
    const created = await app();
    const d = await dashboard(["--dir", created.dir], FIXTURES, {}, "console");
    expect(await answer(api(d, "reload"))).toEqual([
      502,
      { error: `no running rack has the base directory ${created.dir}` },
    ]);
    await d.cli.waitFor(/^reload: /m);
    d.cli.kill("SIGINT");
    expect(await d.cli.exited()).toBe(0);
    expect(lines(d.cli)).toEqual([
      `dashboard of ${created.dir} at ${d.url}`,
      `the rack doesn't answer: no running rack has the base directory ${created.dir}`,
      `reload: no running rack has the base directory ${created.dir}`,
    ]);
    expect(d.cli.output.split(d.token)).toHaveLength(2);
    // Nothing went to standard error.
    expect(d.cli.output).toBe(d.cli.stdout);
  }, 30_000);

  // Only Windows sends SIGBREAK.
  // @decision .agents/decisions/261118_015204-windows.md#changes-to-the-rack
  test.skipIf(!WINDOWS)(
    "on Windows, Ctrl+Break closes it with code 0",
    async () => {
      const d = await dashboard(["--dir", FIXTURES], FIXTURES, {}, "console");
      d.cli.kill("SIGBREAK");
      expect(await d.cli.exited()).toBe(0);
    },
    30_000,
  );
});

describe("the page", () => {
  // @doc docs/reference/cli.md#flags-of-rack-dashboard
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#how-the-page-is-built
  test("serves the page's HTML at /, without the token, with its content security policy, script, and stylesheet", async () => {
    const d = await dashboard(["--dir", FIXTURES]);
    const page = await fetch(`${d.origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    const html = await page.text();
    const meta = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/i.exec(html)?.[0] ?? "";
    const policy = /content="([^"]+)"/.exec(meta)?.[1];
    expect(policy?.split(";").map((directive) => directive.trim())).toEqual(
      expect.arrayContaining([
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
      ]),
    );
    expect(html).not.toContain(d.token);
    // Bun bundled the page's script and stylesheet, which it serves from its own origin.
    const script = /<script type="module"[^>]* src="(\/[^"]+)"/.exec(html)?.[1];
    const style = /<link rel="stylesheet"[^>]* href="(\/[^"]+)"/.exec(html)?.[1];
    for (const [path, type] of [
      [script, "text/javascript"],
      [style, "text/css"],
    ] as const) {
      expect(path).toBeDefined();
      const asset = await fetch(`${d.origin}${path}`);
      expect([path, asset.status]).toEqual([path, 200]);
      expect(asset.headers.get("content-type")).toStartWith(type);
    }
    expect((await fetch(`${d.origin}/nothing`)).status).toBe(404);
    expect(lines(d.cli)).toHaveLength(1);
  }, 30_000);
});
