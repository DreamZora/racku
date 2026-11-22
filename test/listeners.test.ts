/**
 * Tests for listeners: the HTTP servers, WebSocket included, that devices open with
 * `ctx.serve`, and that the rack hands over across swaps.
 *
 * The TLS tests use the self-signed pairs in `fixtures/certs`, made once with
 * `openssl req -x509 -newkey rsa:2048 -nodes -keyout one.key -out one.crt -days 36500
 * -subj "/CN=one.test"`, and the same for `two`. Their keys are public; only these tests trust
 * them.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#listeners
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#defaults-and-bounds
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#hot-swaps
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#cold-swaps-restarts-and-resets
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#port-0
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#conflicts
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#observation
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#tests
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
  fileResponse,
  type RackError,
  type RackHandle,
  rack,
  type SlotStatus,
  slot,
  start,
  wholeResponse,
} from "racku";
import { errorOf, FIXTURES, useRacks, waitFor } from "./fixtures/app.ts";
import { dripResponse, rawHead } from "./fixtures/net.ts";
import { blockingPipe } from "./fixtures/pipe.ts";

const startRack = useRacks();

const LINUX = process.platform === "linux";
const WINDOWS = process.platform === "win32";
const ONE = { cert: "certs/one.crt", key: "certs/one.key" };
const TWO = { cert: "certs/two.crt", key: "certs/two.key" };

afterEach(() => {
  delete process.env.RACKU_TEST_LISTENER;
});

/** Steers the next instance of the listener device, which copies the environment as it starts. */
function steer(value: Record<string, unknown>): void {
  process.env.RACKU_TEST_LISTENER = JSON.stringify(value);
}

const listenerRack = (config: Record<string, unknown> = {}, file = "./devices/listener.ts") => ({
  slots: { 1: slot(file, { config }) },
});

const control = (running: RackHandle, member: string, input?: unknown, device = "listener") =>
  running.call(`${device}.control`, member, input);

const urlOf = async (running: RackHandle, device = "listener") =>
  new URL((await control(running, "url", undefined, device)) as string);

const stateOf = (running: RackHandle, device = "listener") =>
  control(running, "state", undefined, device) as Promise<{
    label: string;
    served: number;
    closes: number[];
  }>;

const statusOf = (running: RackHandle, device = "listener") =>
  running.status().find((s) => s.name === device) as SlotStatus;

async function text(url: URL | string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  return await response.text();
}

/** A free port, which a test then asks a listener for. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);
  return port as number;
}

/** A WebSocket client with the messages it got and the code it closed with. */
async function socketTo(url: URL, path = "/ws") {
  const target = new URL(path, url);
  target.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(target.href, { tls: { rejectUnauthorized: false } } as never);
  const messages: string[] = [];
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  ws.addEventListener("message", (e) => messages.push(String(e.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  await waitFor(() => messages.length > 0);
  return { ws, messages, closed };
}

/** Sends raw request lines on a new connection and returns the response's status line. */
function rawStatus(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0] as string);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("no answer"));
    });
  });
}

/** The common name of the certificate a TLS listener presents for a server name. */
function certificateOf(port: number, servername?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port, rejectUnauthorized: false, ...(servername ? { servername } : {}) },
      () => {
        const subject = socket.getPeerCertificate().subject as { CN?: string } | undefined;
        socket.end();
        resolve(subject?.CN ?? "");
      },
    );
    socket.on("error", reject);
  });
}

/**
 * Sends requests in a loop until `done` settles: on keep-alive connections, or on a new
 * connection each, and counts the ones that failed.
 */
async function loop(url: URL, fresh: boolean, done: Promise<unknown>) {
  let finished = false;
  void done.finally(() => {
    finished = true;
  });
  let ok = 0;
  let failed = 0;
  /** Why requests failed: an HTTP status, or the error of a connection that failed. */
  const statuses: number[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  while (!finished) {
    try {
      const response = await fetch(new URL("/who", url), fresh ? { keepalive: false } : {});
      seen.add((await response.text()).split(" ")[0] as string);
      if (response.status === 200) ok++;
      else {
        failed++;
        statuses.push(response.status);
      }
    } catch (error) {
      failed++;
      errors.push(String(error));
    }
  }
  return { ok, failed, statuses, errors, seen };
}

describe("listeners", () => {
  // @doc docs/guides/listeners.md#opening-a-listener
  test("a device serves HTTP on a listener of its own, on 127.0.0.1 by default", async () => {
    const { running, rec } = await startRack(listenerRack());
    const url = await urlOf(running);
    expect(url.hostname).toBe("127.0.0.1");
    expect(await text(new URL("/who", url))).toMatch(/^v1:\w+ 1$/);
    // Bun counts a request until its response is written; the counters catch up at once after.
    await waitFor(() => statusOf(running).listeners[0]?.requests === 0);
    expect(statusOf(running).listeners).toEqual([
      { url: url.href, certificates: [], requests: 0, webSockets: 0 },
    ]);
    expect(rec.logs).toContainEqual(
      expect.objectContaining({
        device: "listener",
        message: "listening",
        data: { url: url.href },
      }),
    );
  });

  // @doc docs/guides/listeners.md#opening-a-listener
  test("routes, static responses, methods, and an error handler serve as in Bun", async () => {
    const { running } = await startRack(listenerRack());
    const url = await urlOf(running);
    expect(await text(new URL("/route/abc", url))).toBe("v1 route abc");
    expect(await text(new URL("/static", url))).toBe("static");
    expect(await text(new URL("/methods", url), { method: "POST" })).toBe("v1 post");
    const thrown = await fetch(new URL("/throw", url));
    expect([thrown.status, await thrown.text()]).toEqual([500, "handled: thrown on purpose"]);
    expect(await text(new URL("/ip", url))).toBe("127.0.0.1");
  });

  // @doc docs/guides/listeners.md#opening-a-listener
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
  test("a request reaches a route only when its normalized path fits the route, with the same params", async () => {
    const { running } = await startRack(listenerRack());
    const { port } = await urlOf(running);
    const send = async (path: string) => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
      return (await dripResponse(Number(port), lines, [], 10)).split("\r\n\r\n")[1];
    };
    expect(await send("/route/abc")).toBe("v1 route abc");
    expect(await send("/route/a%20b")).toBe("v1 route a b");
    // Bun routes these to /route/:name on their raw paths, which normalizing changes, so fetch
    // takes them, as it takes a path that no route matches.
    for (const path of ["/route/..", "/route/%2e", "/route/a\\..\\abc"]) {
      expect(await send(path)).toBe("not found");
    }
  });

  // @doc docs/guides/listeners.md#opening-a-listener
  test("reload() replaces the handlers and the routes, and open WebSockets stay", async () => {
    const { running } = await startRack(listenerRack());
    const url = await urlOf(running);
    const socket = await socketTo(url);
    await control(running, "reload", "v2");
    expect(await text(new URL("/who", url))).toMatch(/^v2:/);
    expect(await text(new URL("/route/x", url))).toBe("v2 route x");
    socket.ws.send("after");
    // The open WebSocket now gets the new handlers' answers.
    await waitFor(() => socket.messages.some((m) => /^v2:\w+ after$/.test(m)));
  });

  // @doc docs/guides/listeners.md#opening-a-listener
  test("idleTimeout cuts a whole exchange, and timeout() lifts it for one request", async () => {
    const { running } = await startRack(listenerRack({ idleTimeout: 1 }));
    const url = await urlOf(running);
    const [cut, lifted] = await Promise.all([
      fetch(new URL("/slow?ms=5500", url), { keepalive: false }).then(
        (r) => r.text(),
        () => "cut",
      ),
      fetch(new URL("/long?ms=5500", url), { keepalive: false }).then((r) => r.text()),
    ]);
    expect(cut).toBe("cut");
    expect(lifted).toMatch(/ long$/);
  }, 15_000);

  // @doc docs/guides/listeners.md#swaps-and-faults
  // @doc docs/guides/devices.md#the-context
  test("ctx.serve can be called in powerOn only", async () => {
    const { running } = await startRack(listenerRack({ lateServe: true }));
    expect((await stateOf(running)).label).toBe("v1 RACK_HOOK_FAILED");
  });

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("a hot swap keeps serving, finishes requests in flight, and closes WebSockets with 1012", async () => {
    const { running, rec } = await startRack(listenerRack());
    const url = await urlOf(running);
    const before = (await text(new URL("/who", url))).split(" ")[0];
    const socket = await socketTo(url);
    const slow = text(new URL("/slow?ms=600", url));
    await Bun.sleep(50);
    const swapped = running.swap("listener");
    const [kept, fresh] = await Promise.all([loop(url, false, swapped), loop(url, true, swapped)]);
    await swapped;
    expect(kept.failed).toBe(0);
    // Linux and Windows can reset a connection queued for the old listener as it stops, as the
    // README says; no request fails with a status.
    expect(fresh.statuses).toEqual([]);
    expect(fresh.failed).toBeLessThanOrEqual(LINUX || WINDOWS ? 2 : 0);
    expect(await slow).toBe(`${before} slow`);
    expect(await socket.closed).toBe(1012);
    const after = (await text(new URL("/who", url))).split(" ")[0];
    expect(after).not.toBe(before);
    expect(rec.logs).toContainEqual(
      expect.objectContaining({
        device: "listener",
        message: "listener handed over",
        data: { url: url.href, from: expect.any(String), to: expect.any(String) },
      }),
    );
  });

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("requests during a state handover wait for the new instance and see the restored state", async () => {
    // Bun's idle timeout, 4 s at the least, would cut a request that waits longer.
    const { running, rec } = await startRack(
      listenerRack({ snapshotMs: 5_000, idleTimeout: 1 }, "./devices/listener-state.ts"),
    );
    const url = await urlOf(running, "listener-state");
    for (let i = 0; i < 3; i++) await text(new URL("/who", url));
    const swapped = running.swap("listener-state");
    await waitFor(() =>
      rec.logs.some((e) => e.message === "hook" && e.device === "listener-state"),
    );
    const answer = await text(new URL("/who", url), { keepalive: false });
    await swapped;
    // The new instance counts on from the old one's three requests.
    expect(answer).toMatch(/^v1:\w+ 4$/);
  }, 15_000);

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("a response that streams on the old instance doesn't hold a state handover", async () => {
    const { running } = await startRack(listenerRack({}, "./devices/listener-state.ts"));
    const url = await urlOf(running, "listener-state");
    const old = (await text(new URL("/who", url))).split(" ")[0];
    const response = await fetch(new URL("/stream?n=20&gap=150", url));
    const streamed = response.text();
    const started = performance.now();
    const swapped = running.swap("listener-state");
    await waitFor(async () => (await text(new URL("/who", url))).split(" ")[0] !== old, 2_500);
    expect(performance.now() - started).toBeLessThan(2_500);
    await swapped;
    const lines = (await streamed).trim().split("\n");
    expect(lines.length).toBe(20);
    expect(new Set(lines.map((line) => line.split(" ")[0]))).toEqual(new Set([old]));
  });

  test("a hot swap that fails before the switch keeps the old instance listening", async () => {
    const { running } = await startRack(listenerRack());
    const url = await urlOf(running);
    const old = (await text(new URL("/who", url))).split(" ")[0];
    steer({ fail: "selfTest" });
    const swapped = running.swap("listener");
    const fresh = loop(
      url,
      true,
      swapped.catch(() => undefined),
    );
    expect((await errorOf(swapped)).code).toBe("RACK_HOOK_FAILED");
    expect((await fresh).failed).toBe(0);
    expect((await text(new URL("/who", url))).split(" ")[0]).toBe(old);
  });

  for (const hook of ["restore", "activate"]) {
    test(`a hot swap that fails at ${hook}, after the switch, listens on the old instance again, and the requests the new one held get 503`, async () => {
      const { running, rec } = await startRack(
        listenerRack({ snapshotMs: 500 }, "./devices/listener-state.ts"),
      );
      const url = await urlOf(running, "listener-state");
      const old = (await text(new URL("/who", url))).split(" ")[0];
      steer({ fail: hook });
      const swapped = running.swap("listener-state");
      await waitFor(() =>
        rec.logs.some((e) => e.message === "hook" && e.device === "listener-state"),
      );
      // The old instance stopped listening at the switch, so this request waits in the new one.
      const held = await fetch(new URL("/who", url), { keepalive: false });
      expect(held.status).toBe(503);
      expect((await errorOf(swapped)).code).toBe("RACK_HOOK_FAILED");
      expect((await text(new URL("/who", url), { keepalive: false })).split(" ")[0]).toBe(old);
    });
  }

  for (const how of ["restart", "cold swap"]) {
    // @doc docs/guides/listeners.md#swaps-and-faults
    test(`a ${how} refuses connections between the stop and the start, and listens on the same port again`, async () => {
      const file = how === "restart" ? "./devices/listener.ts" : "./devices/listener-cold.ts";
      const { running, rec } = await startRack(listenerRack({}, file));
      const url = await urlOf(running);
      steer({ activateMs: 600 });
      const replaced =
        how === "restart"
          ? running.restart("listener", { cascade: false })
          : running.swap("listener");
      await waitFor(() => rec.logs.some((e) => e.message === "listener closed"));
      expect(await fetch(new URL("/who", url), { keepalive: false }).catch(() => "refused")).toBe(
        "refused",
      );
      await replaced;
      expect(await text(new URL("/who", url), { keepalive: false })).toMatch(/^v1:/);
    });
  }

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("an unplug and stop() close the WebSockets with 1001", async () => {
    const { running } = await startRack({
      slots: { 1: slot("./devices/listener.ts"), 3: slot("./devices/listener-state.ts") },
    });
    const first = await socketTo(await urlOf(running));
    const second = await socketTo(await urlOf(running, "listener-state"));
    await running.unplug("listener-state");
    expect(await second.closed).toBe(1001);
    await running.stop();
    expect(await first.closed).toBe(1001);
  });

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("a crash and a watchdog bite end the connections, and the reset listens on the same port", async () => {
    const { running, rec } = await startRack(listenerRack(), { watchdog: 1_000 });
    const url = await urlOf(running);
    const old = (await text(new URL("/who", url))).split(" ")[0];
    const socket = await socketTo(url);
    await text(new URL("/crash", url));
    await socket.closed;
    await waitFor(async () => {
      const who = await fetch(new URL("/who", url), { keepalive: false }).then(
        (r) => r.text(),
        () => "",
      );
      return who !== "" && who.split(" ")[0] !== old;
    });
    const reset = (await text(new URL("/who", url))).split(" ")[0];
    const blocked = fetch(new URL("/block?ms=3000", url), { keepalive: false }).catch(() => "cut");
    expect(await blocked).toBe("cut");
    await waitFor(
      () => rec.logs.filter((e) => e.message.startsWith("listener crashed")).length >= 1,
    );
    await waitFor(async () => {
      const who = await fetch(new URL("/who", url), { keepalive: false }).then(
        (r) => r.text(),
        () => "",
      );
      return who !== "" && who.split(" ")[0] !== reset;
    }, 10_000);
  }, 20_000);

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("a listener on port 0 keeps its port through swaps, restarts, resets, and fallbacks", async () => {
    const { running } = await startRack(listenerRack({ port: 0 }));
    const url = (await urlOf(running)).href;
    await running.swap("listener");
    expect((await urlOf(running)).href).toBe(url);
    await running.restart("listener", { cascade: false });
    expect((await urlOf(running)).href).toBe(url);
    // A crash on probation, right after the swap, falls back to the known-good firmware.
    await running.swap("listener");
    await text(new URL("/crash", url));
    await waitFor(async () => statusOf(running).state !== "online");
    await waitFor(
      async () => (await fetch(new URL("/who", url)).catch(() => undefined))?.status === 200,
    );
    expect((await urlOf(running)).href).toBe(url);
    await text(new URL("/crash", url));
    await waitFor(
      async () => (await fetch(new URL("/who", url)).catch(() => undefined))?.status === 200,
    );
    expect((await urlOf(running)).href).toBe(url);
  }, 20_000);

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("a thread stuck in native code keeps its port, and status() lists its listeners", async () => {
    const dir = await mkdtemp(join(tmpdir(), "racku-test-"));
    const pipe = await blockingPipe(dir);
    try {
      steer({ jam: pipe.path });
      const { running } = await startRack(listenerRack(), { watchdog: 1_000, hookTimeout: 1_000 });
      const url = await urlOf(running);
      void fetch(new URL("/jam", url)).catch(() => undefined);
      await waitFor(() => statusOf(running).stuck.length === 1, 10_000);
      expect(statusOf(running).stuck[0]?.listeners).toEqual([
        { url: url.href, certificates: [], requests: expect.any(Number), webSockets: 0 },
      ]);
      // The system still accepts connections to the port, and nothing answers them.
      const unanswered = await Promise.race([
        fetch(new URL("/who", url), { keepalive: false }).then(
          () => "answered",
          () => "failed",
        ),
        Bun.sleep(1_000).then(() => "no answer"),
      ]);
      expect(unanswered).toBe("no answer");
      delete process.env.RACKU_TEST_LISTENER;
      expect(await pipe.release()).toBe(true);
      await waitFor(() => statusOf(running).stuck.length === 0, 10_000);
      await running.restart("listener", { cascade: false });
      expect(await text(new URL("/who", url))).toMatch(/^v1:/);
    } finally {
      await pipe.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// @doc docs/guides/listeners.md#conflicts
describe("listener conflicts", () => {
  test("two devices on one port fail with RACK_HOOK_FAILED and name the holder", async () => {
    const port = await freePort();
    const error = await errorOf(
      startRack({
        slots: {
          1: slot("./devices/listener.ts", { config: { port } }),
          3: slot("./devices/listener-state.ts", { config: { port } }),
        },
      }),
    );
    expect(error.code).toBe("RACK_HOOK_FAILED");
    expect(error.data).toMatchObject({ listener: `127.0.0.1:${port}`, holder: "listener" });
  });

  test("one port on two hostnames conflicts in one rack", async () => {
    const port = await freePort();
    const error = await errorOf(
      startRack({
        slots: {
          1: slot("./devices/listener.ts", { config: { port, hostname: "0.0.0.0" } }),
          3: slot("./devices/listener-state.ts", { config: { port } }),
        },
      }),
    );
    expect(error.data).toMatchObject({ holder: "listener" });
  });

  for (const reusePort of [false, true]) {
    test(`a port that another process holds ${reusePort ? "with" : "without"} reusePort fails with the holder "another process"`, async () => {
      const port = await freePort();
      const other = Bun.serve({
        hostname: "127.0.0.1",
        port,
        reusePort,
        fetch: () => new Response(),
      });
      try {
        const error = await errorOf(startRack(listenerRack({ port })));
        expect(error.code).toBe("RACK_HOOK_FAILED");
        expect(error.data).toMatchObject({
          listener: `127.0.0.1:${port}`,
          holder: "another process",
          cause: "EADDRINUSE",
        });
      } finally {
        await other.stop(true);
      }
    });
  }

  test("a second rack on the same port is refused", async () => {
    const port = await freePort();
    await startRack(listenerRack({ port }));
    const second = start(rack("second", listenerRack({ port })), {
      baseDir: FIXTURES,
      logger: () => {},
    });
    expect((await errorOf(second)).data).toMatchObject({ holder: "another process" });
  });

  // @doc docs/guides/listeners.md#swaps-and-faults
  test("a device that catches a rejected serve() still fails its powerOn", async () => {
    const port = await freePort();
    const other = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    try {
      const error = await errorOf(startRack(listenerRack({ port, catchServe: true })));
      expect(error.code).toBe("RACK_HOOK_FAILED");
      expect(error.data).toMatchObject({ holder: "another process" });
    } finally {
      await other.stop(true);
    }
  });
});

// @doc docs/guides/listeners.md#opening-a-listener
describe("listener defaults and limits", () => {
  test("a loopback listener answers 403 for another host, WebSocket upgrades included", async () => {
    const { running } = await startRack(listenerRack({ allowedHosts: ["app.test"] }));
    const { port } = await urlOf(running);
    const status = (host: string, path = "/who", extra: string[] = []) =>
      rawStatus(Number(port), [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Connection: close",
        ...extra,
      ]);
    expect(await status("evil.test")).toStartWith("HTTP/1.1 403");
    const upgrade = [
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
    ];
    expect(await status("evil.test", "/ws", upgrade)).toStartWith("HTTP/1.1 403");
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "app.test"]) {
      expect(await status(host)).toStartWith("HTTP/1.1 200");
    }
    // A Host of another form than name, name:port, [ipv6], or [ipv6]:port gets 403.
    // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
    for (const host of [
      `127.0.0.1:${port}x`,
      "127.0.0.1:99999",
      `127.0.0.1:${port}/x`,
      "127.0.0.1@evil.test",
      "[::1",
      "127.0.0.1:",
    ]) {
      expect(await status(host)).toStartWith("HTTP/1.1 403");
    }
  });

  // Windows binds no 127.1, as Linux and macOS do; there, no listener can have that spelling.
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#the-http-panel-and-listeners
  test.skipIf(WINDOWS)("every spelling of loopback gets the Host check", async () => {
    const { running } = await startRack(listenerRack({ hostname: "127.1" }));
    const { port, hostname } = await urlOf(running);
    expect(hostname).toBe("127.0.0.1");
    const status = (host: string) =>
      rawStatus(Number(port), ["GET /who HTTP/1.1", `Host: ${host}`, "Connection: close"]);
    expect(await status("evil.test")).toStartWith("HTTP/1.1 403");
    for (const host of [`127.0.0.1:${port}`, `127.1:${port}`, `LOCALHOST:${port}`]) {
      expect(await status(host)).toStartWith("HTTP/1.1 200");
    }
  });

  test("a listener on 0.0.0.0 serves any host", async () => {
    const { running } = await startRack(listenerRack({ hostname: "0.0.0.0" }));
    const { port } = await urlOf(running);
    expect(
      await rawStatus(Number(port), [
        "GET /who HTTP/1.1",
        "Host: anything.test",
        "Connection: close",
      ]),
    ).toStartWith("HTTP/1.1 200");
  });

  // @doc docs/reference/limits.md#listeners
  test("a body over 1 MiB gets 413", async () => {
    const { running } = await startRack(listenerRack());
    const { port } = await urlOf(running);
    const lines = (length: number) => [
      "POST /body HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Content-Length: ${length}`,
      "Connection: close",
    ];
    expect(await rawStatus(Number(port), lines(2 * 1024 * 1024))).toStartWith("HTTP/1.1 413");
    const url = await urlOf(running);
    expect(
      await text(new URL("/body", url), { method: "POST", body: new Uint8Array(512 * 1024) }),
    ).toBe(String(512 * 1024));
  });

  // @doc docs/reference/limits.md#listeners
  test("a WebSocket message over 1 MiB closes the WebSocket with 1009", async () => {
    const { running } = await startRack(listenerRack());
    const socket = await socketTo(await urlOf(running));
    socket.ws.send(new Uint8Array(1.5 * 1024 * 1024));
    expect(await socket.closed).toBe(1009);
  });

  // @doc docs/reference/limits.md#listeners
  test("a client that doesn't read is closed with 1013 once 1 MiB is unsent", async () => {
    const { running } = await startRack(listenerRack());
    const { port } = await urlOf(running);
    const client = await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port: Number(port) }, () => {
        socket.write(
          `${[
            "GET /ws HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
          ].join("\r\n")}\r\n\r\n`,
        );
      });
      socket.once("data", () => {
        // Reads nothing more: the server's sends pile up.
        socket.pause();
        resolve(socket);
      });
      socket.on("error", reject);
    });
    try {
      const flooded = (await control(running, "flood", {
        id: 1,
        size: 64 * 1024,
        count: 2_000,
      })) as {
        sent: number;
        closed: boolean;
      };
      expect(flooded.closed).toBe(true);
      expect(flooded.sent).toBeLessThan(2_000);
      await waitFor(async () => (await stateOf(running)).closes.includes(1013));
    } finally {
      client.destroy();
    }
  });

  // @doc docs/reference/limits.md#timeouts
  test("an idle keep-alive connection closes after idleTimeout, within Bun's steps of 4 s", async () => {
    const { running } = await startRack(listenerRack({ idleTimeout: 1 }));
    const { port } = await urlOf(running);
    const started = performance.now();
    const closedAfter = await new Promise<number>((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port: Number(port) }, () => {
        socket.write(`GET /who HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      });
      socket.on("data", () => {});
      socket.on("close", () => resolve(performance.now() - started));
      socket.on("error", reject);
    });
    expect(closedAfter).toBeGreaterThan(500);
    expect(closedAfter).toBeLessThan(6_000);
  }, 10_000);
});

describe("listener certificates", () => {
  // @doc docs/guides/listeners.md#certificates
  test("setTls() gives new connections the new certificate, and keeps the old ones open", async () => {
    const { running, rec } = await startRack(listenerRack({ tls: ONE }));
    const url = await urlOf(running);
    const port = Number(url.port);
    expect(url.protocol).toBe("https:");
    expect(await certificateOf(port)).toBe("one.test");
    expect(statusOf(running).listeners[0]?.certificates).toEqual([
      { subject: "CN=one.test", notAfter: expect.any(Number) },
    ]);
    const before = await socketTo(url);
    await control(running, "setTls", TWO);
    expect(await certificateOf(port)).toBe("two.test");
    before.ws.send("still there?");
    await waitFor(() => before.messages.some((m) => m.endsWith("still there?")));
    expect(rec.logs).toContainEqual(
      expect.objectContaining({ device: "listener", message: "certificates replaced" }),
    );
    // A pair whose key doesn't match is rejected, and the old pair stays.
    const bad = await errorOf(control(running, "setTls", { cert: ONE.cert, key: TWO.key }));
    expect(bad.code).toBe("RACK_INVALID_CONFIG");
    expect(await certificateOf(port)).toBe("two.test");
    expect(rec.logs).toContainEqual(
      expect.objectContaining({ device: "listener", message: "certificates rejected" }),
    );
    // A second setTls() closes the WebSockets of the oldest server with 1012.
    const after = await socketTo(url);
    await control(running, "setTls", ONE);
    expect(await before.closed).toBe(1012);
    expect(after.ws.readyState).toBe(WebSocket.OPEN);
  });

  // @doc docs/guides/listeners.md#certificates
  test("publish() reaches the WebSockets on both servers of a listener", async () => {
    const { running } = await startRack(listenerRack({ tls: ONE }));
    const url = await urlOf(running);
    const before = await socketTo(url);
    await control(running, "setTls", TWO);
    const after = await socketTo(url);
    expect(await control(running, "publish", { topic: "news", data: "hello" })).toBeGreaterThan(0);
    await waitFor(() => before.messages.includes("hello") && after.messages.includes("hello"));
  });

  // @doc docs/guides/listeners.md#certificates
  test("with a list of certificates, a listener picks one by server name", async () => {
    const { running } = await startRack(
      listenerRack({
        tls: [
          { ...ONE, serverName: "one.test" },
          { ...TWO, serverName: "two.test" },
        ],
      }),
    );
    const port = Number((await urlOf(running)).port);
    expect(await certificateOf(port, "one.test")).toBe("one.test");
    expect(await certificateOf(port, "two.test")).toBe("two.test");
    expect(await certificateOf(port, "other.test")).toBe("one.test");
  });

  // @doc docs/guides/listeners.md#swaps-and-faults
  // @doc docs/reference/limits.md#listeners
  test("an instance has at most 16 listeners", async () => {
    const more = Array.from({ length: 16 }, () => ({ port: 0 }));
    const error = await errorOf(startRack(listenerRack({ more })));
    expect([error.code, error.message]).toEqual([
      "RACK_HOOK_FAILED",
      "listener: ctx.serve: an instance has at most 16 listeners",
    ]);
    await startRack(listenerRack({ more: more.slice(1) }));
  });

  // @doc docs/guides/listeners.md#certificates
  test("a certificate that doesn't load fails powerOn", async () => {
    const error = await errorOf(startRack(listenerRack({ tls: { cert: ONE.cert, key: TWO.key } })));
    expect(error.code).toBe("RACK_HOOK_FAILED");
  });
});

// @doc docs/guides/listeners.md#observation
describe("listener observation", () => {
  // @doc docs/reference/reports.md#status
  test("status() reports the requests in flight and the open WebSockets", async () => {
    const { running } = await startRack(listenerRack());
    const url = await urlOf(running);
    const socket = await socketTo(url);
    const slow = text(new URL("/slow?ms=800", url));
    await waitFor(() => statusOf(running).listeners[0]?.requests === 1);
    expect(statusOf(running).listeners[0]?.webSockets).toBe(1);
    await slow;
    socket.ws.close();
    await waitFor(() => statusOf(running).listeners[0]?.webSockets === 0);
  });

  // @doc docs/reference/reports.md#the-log
  test("the log reports listener closed when a listener stops for good", async () => {
    const { running, rec } = await startRack({
      slots: { 1: slot("./devices/listener.ts"), 3: slot("./devices/listener-state.ts") },
    });
    const url = await urlOf(running, "listener-state");
    await running.unplug("listener-state");
    expect(rec.logs).toContainEqual(
      expect.objectContaining({
        device: "listener-state",
        message: "listener closed",
        data: { url: url.href },
      }),
    );
  });
});

// @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#tests

/** Sends "ping" to a TCP echo server, and resolves with what comes back. */
function echo(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write("ping");
        },
        data(socket, data) {
          socket.end();
          resolve(new TextDecoder().decode(data));
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

// @doc docs/guides/listeners.md#other-sockets
describe("other sockets", () => {
  test("a socket that a device opens with Bun.listen closes with its instance, and the rack doesn't hand it over", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/raw-socket.ts") } });
    const port = (await running.call("raw-socket.raw", "port", undefined)) as number;
    expect(await echo(port)).toBe("ping");
    expect(statusOf(running, "raw-socket").listeners).toEqual([]);

    await running.swap("raw-socket");
    const next = (await running.call("raw-socket.raw", "port", undefined)) as number;
    expect(next).not.toBe(port);
    expect(await echo(next)).toBe("ping");
    expect(statusOf(running, "raw-socket").listeners).toEqual([]);
    // The old instance's server closed with its Worker; nothing moved it to the new one.
    await waitFor(async () => (await echo(port).catch(() => "refused")) === "refused");
  });
});

// @doc docs/guides/listeners.md#bodies-in-memory
describe("wholeResponse", () => {
  /** The head of a response, in lowercase, as a client gets it. */
  const headOf = async (port: number, method: string, path: string) =>
    (
      await rawHead(port, [
        `${method} ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ])
    ).toLowerCase();

  test("a body in memory keeps its Content-Length at every size, from a handler that answers after an await", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await Bun.sleep(1);
        const url = new URL(request.url);
        const size = Number(url.searchParams.get("size") ?? 0);
        const kind = url.searchParams.get("kind");
        const bytes = new TextEncoder().encode("a".repeat(size));
        const body =
          kind === "text"
            ? "a".repeat(size)
            : kind === "buffer"
              ? bytes.buffer
              : kind === "none"
                ? null
                : bytes;
        const init = url.searchParams.has("init")
          ? { status: 201, headers: { "content-type": "application/x-test", "x-test": "yes" } }
          : undefined;
        return wholeResponse(request, body, init);
      },
    });
    try {
      // A server on a TCP port always has one.
      const port = server.port as number;
      for (const size of [15_359, 15_360]) {
        for (const [kind, type] of [
          ["bytes", "application/octet-stream"],
          ["text", "text/plain;charset=utf-8"],
        ]) {
          const head = await headOf(port, "GET", `/?size=${size}&kind=${kind}`);
          expect(head).toContain(`content-length: ${size}`);
          expect(head).toContain(`content-type: ${type}`);
          expect(head).not.toContain("transfer-encoding");
          const body = await (
            await fetch(`http://127.0.0.1:${port}/?size=${size}&kind=${kind}`)
          ).text();
          expect(body === "a".repeat(size)).toBe(true);
        }
      }
      expect(await headOf(port, "GET", "/?size=20000&kind=buffer")).toContain(
        "content-length: 20000",
      );
      const head = await headOf(port, "HEAD", "/?size=20000");
      expect(head).toContain("content-length: 20000");
      expect(head).not.toContain("transfer-encoding");
      for (const size of [100, 20_000]) {
        const named = await headOf(port, "GET", `/?size=${size}&init`);
        expect(named.startsWith("http/1.1 201")).toBe(true);
        expect(named).toContain("content-type: application/x-test");
        expect(named).toContain("x-test: yes");
        expect(named).toContain(`content-length: ${size}`);
      }
      const none = await fetch(`http://127.0.0.1:${port}/?kind=none`);
      expect([none.status, await none.text()]).toEqual([200, ""]);
    } finally {
      server.stop(true);
    }
  });

  test("a device that answers with ctx.serve after an await keeps its Content-Length", async () => {
    const { running } = await startRack(listenerRack());
    const url = await urlOf(running);
    const head = await headOf(Number(url.port), "GET", "/whole?size=20000");
    expect(head).toContain("content-length: 20000");
    expect(head).not.toContain("transfer-encoding");
    const body = new Uint8Array(
      await (await fetch(new URL("/whole?size=20000", url))).arrayBuffer(),
    );
    expect([body.byteLength, body.every((byte) => byte === 7)]).toEqual([20_000, true]);
  });
});

// @doc docs/guides/listeners.md#files
// @doc README.md#status
// @decision .agents/decisions/261119_205344-file-responses.md#tests
describe("fileResponse", () => {
  const headOf = async (port: number, method: string, path: string) =>
    (
      await rawHead(port, [
        `${method} ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
      ])
    ).toLowerCase();

  test("a device that answers a file through its own listener sends it from disk, with its Content-Length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "racku-files-"));
    try {
      const size = 3 * 1024 * 1024;
      const path = join(dir, "photo.bin");
      await Bun.write(path, new Uint8Array(size).fill(9));
      const { running } = await startRack(listenerRack());
      const url = await urlOf(running);
      const query = `/file?path=${encodeURIComponent(path)}`;
      const head = await headOf(Number(url.port), "GET", query);
      expect(head).toContain(`content-length: ${size}`);
      // Bun would name the file on disk; fileResponse keeps the name private.
      expect(head).toContain("content-disposition: inline");
      expect(head).not.toContain("photo.bin");
      expect(head).not.toContain("transfer-encoding");
      expect(await headOf(Number(url.port), "HEAD", query)).toContain(`content-length: ${size}`);
      const body = new Uint8Array(await (await fetch(new URL(query, url))).arrayBuffer());
      expect([body.byteLength, body.every((byte) => byte === 9)]).toEqual([size, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fileResponse refuses a file without a path", () => {
    let code: string | undefined;
    try {
      fileResponse(Bun.file(0));
    } catch (error) {
      code = (error as RackError).code;
    }
    expect(code).toBe("RACK_INVALID_INPUT");
  });
});
