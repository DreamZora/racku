/**
 * Tests for the standard HTTP panel, `http-panel`, and for `http/v2` and `httpHandler`, through
 * which it reaches the devices its routes name: README.md, "HTTP panel".
 *
 * The TLS tests use the self-signed pairs in `fixtures/certs`, made once with
 * `openssl req -x509 -newkey rsa:2048 -nodes -keyout one.key -out one.crt -days 36500
 * -subj "/CN=one.test"`, and the same for `two` and `three`. Their keys are public; only these
 * tests trust them.
 *
 * @decision .agents/decisions/261118_071513-http-panel-device.md#tests
 * @decision .agents/decisions/261118_071513-http-panel-device.md#requests
 * @decision .agents/decisions/261118_071513-http-panel-device.md#websocket
 * @decision .agents/decisions/261118_071513-http-panel-device.md#swaps
 * @decision .agents/decisions/261118_071513-http-panel-device.md#certificates-that-change
 * @decision .agents/decisions/261118_071513-http-panel-device.md#the-connector
 * @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
 * @decision .agents/decisions/261118_071513-http-panel-device.md#observation
 * @decision .agents/decisions/261118_165318-stream-threshold.md#tests
 * @decision .agents/decisions/261118_165318-stream-threshold.md#cancellation
 * @decision .agents/decisions/261118_195832-faster-panel-responses.md#tests
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallContext,
  type DeviceMetrics,
  type PortEmitter,
  type RackHandle,
  rack,
  type SlotStatus,
  type StartOptions,
  slot,
} from "rack42u";
import { Http, type HttpPanelConfig, httpHandler, httpPanel } from "rack42u/std";
import * as v from "valibot";
import { describeConnector } from "../src/connector.ts";
import { planRack } from "../src/rack.ts";
import { PanelConfig, SYNC_MS } from "../src/std/http-panel.ts";
import { errorOf, FIXTURES, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";
import {
  certificateOf,
  dripResponse,
  freePort,
  rawHead,
  rawStatus,
  socketTo,
  stalledSocket,
  UPGRADE_HEADERS,
} from "./fixtures/net.ts";

const startRack = useRacks();

const MiB = 1024 * 1024;
const WEB = slot("./devices/web.ts");
const CHAT = slot("./devices/chat.ts");
const ROUTES = {
  "/web/*": "web.http",
  "/items/:id": "web.http",
  "/chat": "chat.http",
  "/chat/*": "chat.http",
};

const temporary: string[] = [];
const apps: TempApp[] = [];
afterEach(async () => {
  delete process.env.RACK42U_TEST_PANEL_SYNC_MS;
  setSystemTime();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** Starts `web` and `chat` with a panel above them that routes to both. */
async function panelRack(config: Partial<HttpPanelConfig> = {}, options: StartOptions = {}) {
  const { running, rec } = await startRack(
    { slots: { 1: WEB, 2: CHAT, 3: httpPanel({ port: 0, routes: ROUTES, ...config }) } },
    options,
  );
  const url = new URL(rec.panelUrl());
  const get = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
  return { running, rec, url, port: Number(url.port), get };
}

async function metricsOf(running: RackHandle, name: string): Promise<DeviceMetrics> {
  const found = (await running.metrics()).devices.find((d) => d.device === name);
  if (found === undefined) throw new Error(`no metrics for ${name}`);
  return found;
}

const statusOf = (running: RackHandle, name: string) =>
  running.status().find((s) => s.name === name) as SlotStatus;

const upgrade = (port: number, path: string) => [
  `GET ${path} HTTP/1.1`,
  `Host: 127.0.0.1:${port}`,
  ...UPGRADE_HEADERS,
];

type ChatState = {
  instance: string;
  sockets: string[];
  closes: { socket: string; code: number }[];
  starts: number[];
  maxActive: number;
};

const chatState = async (url: URL): Promise<ChatState> =>
  (await (await fetch(new URL("/chat/state", url))).json()) as ChatState;

/** The socket id at the end of the chat device's welcome message. */
const idOf = (welcome: string | undefined) => welcome?.split(" ").at(-1) as string;

/** Error entries of the panel's log. */
const panelErrors = (rec: { logs: { device?: string; level: string; message: string }[] }) =>
  rec.logs.filter((e) => e.device === "http-panel" && e.level === "error");

describe("http-panel requests", () => {
  test("README.md: passes the method, URL, headers, and body to the port its route names", async () => {
    const { get } = await panelRack();
    const response = await get("/web/echo?x=1", {
      method: "POST",
      headers: { "x-test": "yes", "content-type": "text/plain" },
      body: "payload",
    });
    const echoed = (await response.json()) as { headers: [string, string][] };
    expect(echoed).toMatchObject({
      method: "POST",
      path: "/web/echo",
      query: "?x=1",
      body: "payload",
    });
    expect(echoed.headers).toContainEqual(["x-test", "yes"]);
    expect(await (await get("/web/greeting")).text()).toBe("hello");
  });

  test("README.md: passes route parameters", async () => {
    const { get } = await panelRack();
    expect(await (await get("/items/42")).json()).toEqual({ id: "42" });
  });

  test("README.md: keeps duplicate response headers such as Set-Cookie", async () => {
    const { get } = await panelRack();
    expect((await get("/web/cookies")).headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  test("README.md: answers an unmatched path with 404", async () => {
    const { get } = await panelRack();
    const response = await get("/elsewhere");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "RACK_NO_ROUTE", message: "no route matches" });
  });

  test("README.md: answers a failed call with 502, as it does response headers that Response rejects", async () => {
    const { get } = await panelRack();
    const failed = await get("/web/boom");
    expect([failed.status, await failed.json()]).toEqual([
      502,
      { code: "RACK_DEVICE_FAULT", message: "boom" },
    ]);
    const bad = await get("/web/bad-header");
    expect(bad.status).toBe(502);
    expect(((await bad.json()) as { code: string }).code).toBe("RACK_INVALID_OUTPUT");
  });

  test("README.md: answers 504 when the response head comes later than callTimeout", async () => {
    const { get } = await panelRack({}, { callTimeout: 100 });
    const response = await get("/web/slow");
    expect(response.status).toBe(504);
    expect(((await response.json()) as { code: string }).code).toBe("RACK_TIMEOUT");
  });

  test("README.md: answers 503 for a device that is down", async () => {
    const { running, rec, get } = await panelRack();
    const crashes = () => rec.events.filter((e) => e.type === "fault").length;
    for (let n = 1; n <= 4; n++) {
      await get("/web/crash").catch(() => undefined);
      await waitFor(() => crashes() === n);
      if (n < 4) await waitFor(() => statusOf(running, "web").state === "online");
    }
    const response = await get("/web/greeting");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("RACK_LINK_DOWN");
  });

  test("README.md: answers 413 for a body over maxBodySize, with a declared length or chunked", async () => {
    const { running, port } = await panelRack({ maxBodySize: 64 * 1024 });
    const head = (extra: string) => [
      "POST /web/upload HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      extra,
      "Connection: close",
    ];
    expect(await rawStatus(port, head(`Content-Length: ${128 * 1024}`))).toStartWith(
      "HTTP/1.1 413",
    );
    const chunk = "x".repeat(16 * 1024);
    const chunked = `${`${chunk.length.toString(16)}\r\n${chunk}\r\n`.repeat(8)}0\r\n\r\n`;
    expect(await rawStatus(port, head("Transfer-Encoding: chunked"), chunked)).toStartWith(
      "HTTP/1.1 413",
    );
    // The chunked body reached the device as a stream, which failed when it crossed the limit.
    const streams = await waitFor(async () => {
      const served = (await metricsOf(running, "web")).provides.http?.handle;
      return served?.kind === "rpc" && served.streams?.open === 0 && served.streams;
    });
    expect(streams).toMatchObject({ opened: 1, errors: { RACK_INVALID_INPUT: 1 } });
  });

  test("README.md: answers 408 when the client stops sending its body, as bytes or as a stream", async () => {
    const { port } = await panelRack({ idleTimeout: 1 });
    const head = (extra: string) => ["POST /web/upload HTTP/1.1", `Host: 127.0.0.1:${port}`, extra];
    // A declared length up to streamThreshold travels as bytes, which the panel reads first.
    const started = performance.now();
    expect(await rawStatus(port, head("Content-Length: 1000"), "0123456789")).toStartWith(
      "HTTP/1.1 408",
    );
    expect(performance.now() - started).toBeGreaterThan(900);
    // A chunked body streams to the device, which waits for more.
    expect(
      await rawStatus(port, head("Transfer-Encoding: chunked"), "a\r\n0123456789\r\n"),
    ).toStartWith("HTTP/1.1 408");
  });

  test("README.md: a body sent whole must arrive within idleTimeout, while a streamed one may take longer as long as it moves", async () => {
    const { port } = await panelRack({ idleTimeout: 1 });
    const head = (extra: string) => [
      "POST /web/upload HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      extra,
      "Connection: close",
    ];
    // 2 bytes every 200 ms: 2 s for the body, and never 1 s without bytes.
    const pieces = Array.from({ length: 10 }, () => "xx");
    const started = performance.now();
    const whole = await dripResponse(port, head("Content-Length: 20"), pieces, 200);
    expect(whole).toStartWith("HTTP/1.1 408");
    expect(whole).toContain("the client didn't send its body within idleTimeout");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(1_900);
    const chunks = [...pieces.map((piece) => `2\r\n${piece}\r\n`), "0\r\n\r\n"];
    const streamed = await dripResponse(port, head("Transfer-Encoding: chunked"), chunks, 200);
    expect(streamed).toStartWith("HTTP/1.1 200");
    expect(streamed.endsWith("\r\n\r\n20")).toBe(true);
  });

  test("README.md: answers 504 when the device stops reading the body", async () => {
    const { port } = await panelRack({ idleTimeout: 1, maxBodySize: 16 * MiB });
    const size = 8 * MiB;
    const started = performance.now();
    const status = await rawStatus(
      port,
      ["POST /web/ignore-body HTTP/1.1", `Host: 127.0.0.1:${port}`, `Content-Length: ${size}`],
      "x".repeat(size),
    );
    expect(status).toStartWith("HTTP/1.1 504");
    expect(performance.now() - started).toBeGreaterThan(900);
  });

  test("README.md: callTimeout runs from the end of the request body to the response head", async () => {
    // The body is over streamThreshold, so it streams, and the call starts with its first bytes.
    const { port } = await panelRack({ streamThreshold: 64 * 1024 }, { callTimeout: 300 });
    // The client sends the second half of its body after longer than callTimeout.
    const half = "x".repeat(100 * 1024);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `POST /web/upload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${2 * half.length}\r\nConnection: close\r\n\r\n${half}`,
        );
        setTimeout(() => socket.write(half), 600);
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(response).toStartWith("HTTP/1.1 200");
    expect(response.endsWith(`\r\n\r\n${2 * half.length}`)).toBe(true);
  });

  test("README.md: Bun's timer doesn't cut a request while the panel waits for its device", async () => {
    const { get } = await panelRack({ idleTimeout: 1 });
    // Bun alone would cut an exchange this long, as the listener tests show.
    expect(await (await get("/web/sleep?ms=5500", { keepalive: false })).text()).toBe("slept");
  }, 15_000);

  test("README.md: a response body that fails or stalls after its head ends the response abruptly", async () => {
    const { get } = await panelRack({ idleTimeout: 1 });
    const rest = async (path: string) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      return await reader.read().then(
        () => "more",
        () => "cut",
      );
    };
    expect(await rest("/web/broken")).toBe("cut");
    const started = performance.now();
    expect(await rest("/web/stall")).toBe("cut");
    expect(performance.now() - started).toBeGreaterThan(900);
  });

  test("README.md: a client that goes away cancels the call, with RACK_CANCELLED at the device", async () => {
    const { running, get } = await panelRack();
    // A call that ends leaves its controller to the next one, which the client then cancels.
    expect(await (await get("/web/greeting")).text()).toBe("hello");
    const controller = new AbortController();
    const pending = get("/web/slow", { signal: controller.signal }).catch(() => "gone");
    await waitFor(() => statusOf(running, "web").inFlight === 1);
    // Mostly before the panel reads the client's signal, which it does 100 ms to 200 ms after a
    // call starts: the signal it reads then reports the client gone.
    controller.abort();
    expect(await pending).toBe("gone");
    const errors = await waitFor(async () => {
      const handle = (await metricsOf(running, "web")).provides.http?.handle;
      return handle?.kind === "rpc" && handle.active === 0 && handle.errors;
    });
    expect(errors).toEqual({ RACK_CANCELLED: 1 });
  });

  // @decision .agents/decisions/261118_215039-content-length-for-known-sizes.md#tests
  test("README.md: a response body sent whole keeps its Content-Length at every size, and a stream goes out chunked", async () => {
    const { port } = await panelRack();
    const head = async (method: string, path: string) =>
      (
        await rawHead(port, [
          `${method} ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: close",
        ])
      ).toLowerCase();
    const download = (size: number) => `/web/download?size=${size}&chunk=${size}`;
    for (const size of [14 * 1024, 15 * 1024, 16 * 1024 * 1024]) {
      const lines = await head("GET", download(size));
      expect(lines).toContain(`content-length: ${size}`);
      expect(lines).toContain("content-type: application/octet-stream");
      expect(lines).not.toContain("transfer-encoding");
    }
    expect(await head("HEAD", download(20_000))).toContain("content-length: 20000");
    const events = await head("GET", "/web/events?n=2&gap=50");
    expect(events).toContain("transfer-encoding: chunked");
    expect(events).not.toContain("content-length");
    // A body sent whole arrives whole.
    for (const size of [15 * 1024, 16 * 1024 * 1024]) {
      const url = new URL(download(size), `http://127.0.0.1:${port}`);
      const body = new Uint8Array(await (await fetch(url)).arrayBuffer());
      expect([body.byteLength, body.every((byte) => byte === 7)]).toEqual([size, true]);
    }
  });

  test("README.md: streamThreshold decides which request bodies go to the device as bytes and which stream", async () => {
    const { running, get } = await panelRack({ streamThreshold: 1024 });
    const opened = async () => {
      const handle = (await metricsOf(running, "web")).provides.http?.handle;
      return handle?.kind === "rpc" ? (handle.streams?.opened ?? 0) : undefined;
    };
    const upload = async (size: number) =>
      await (await get("/web/upload", { method: "POST", body: new Uint8Array(size) })).text();
    expect(await upload(1024)).toBe("1024");
    expect(await opened()).toBe(0);
    expect(await upload(1025)).toBe("1025");
    expect(await opened()).toBe(1);
    await running.stop();
    // With 0, every body that has bytes streams.
    const none = await panelRack({ streamThreshold: 0 });
    expect(await (await none.get("/web/upload", { method: "POST", body: "x" })).text()).toBe("1");
    const handle = (await metricsOf(none.running, "web")).provides.http?.handle;
    expect(handle?.kind === "rpc" && handle.streams?.opened).toBe(1);
  });

  test("serves through the installed instance after a swap", async () => {
    const { running, get } = await panelRack();
    const before = await (await get("/web/who")).text();
    await running.swap("web");
    expect(await (await get("/web/who")).text()).not.toBe(before);
    expect(await (await get("/web/greeting")).text()).toBe("hello");
  });
});

/**
 * Sends a request whose body of `size` bytes it writes as fast as the connection takes it, and
 * counts the bytes written.
 */
function pushBody(port: number, path: string, size: number) {
  let written = 0;
  const response = new Promise<string>((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`,
      );
      const chunk = new Uint8Array(64 * 1024).fill(1);
      const write = () => {
        while (written < size) {
          const piece = chunk.subarray(0, Math.min(chunk.byteLength, size - written));
          written += piece.byteLength;
          if (!socket.write(piece)) {
            socket.once("drain", write);
            return;
          }
        }
      };
      write();
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  return { written: () => written, response };
}

describe("http-panel streams", () => {
  test("README.md: a large upload streams to the device, which slows the client", async () => {
    const { port } = await panelRack({ maxBodySize: 64 * MiB });
    const size = 48 * MiB;
    // The device stops reading after 1 MiB for 1.5 s.
    const client = pushBody(port, `/web/upload?hold=${MiB}&ms=1500`, size);
    await Bun.sleep(1_000);
    // What the client could write meanwhile: the window, and what Bun and the system buffer.
    expect(client.written()).toBeLessThan(24 * MiB);
    const response = await client.response;
    expect(response).toStartWith("HTTP/1.1 200");
    expect(response.endsWith(`\r\n\r\n${size}`)).toBe(true);
  });

  test("README.md: a large download streams to the client, whose pace slows the device", async () => {
    const { port, get } = await panelRack();
    const size = 64 * MiB;
    let received = 0;
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `GET /web/download?size=${size} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    const ended = new Promise<void>((resolve, reject) => {
      socket.on("end", resolve);
      socket.on("error", reject);
    });
    socket.on("data", (chunk) => {
      received += (chunk as Buffer).byteLength;
    });
    await waitFor(() => received > 0);
    socket.pause();
    await Bun.sleep(1_000);
    const produced = Number(await (await get("/web/produced")).text());
    expect(produced).toBeLessThan(received + 24 * MiB);
    socket.resume();
    await ended;
    // The body, in chunked encoding, and the head.
    expect(received).toBeGreaterThan(size);
  });

  test("README.md: server-sent events arrive as the device sends them", async () => {
    const { get } = await panelRack();
    const response = await get("/web/events?n=3&gap=300");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const arrivals: number[] = [];
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      arrivals.push(performance.now());
      text += decoder.decode(next.value, { stream: true });
    }
    expect(text).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n");
    expect((arrivals.at(-1) as number) - (arrivals[0] as number)).toBeGreaterThan(400);
  });

  test("README.md: a client that goes away cancels the device's stream", async () => {
    const { running, get } = await panelRack();
    const controller = new AbortController();
    const response = await get("/web/events?n=1000&gap=50", { signal: controller.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await waitFor(async () => {
      const handle = (await metricsOf(running, "web")).provides.http?.handle;
      return handle?.kind === "rpc" && handle.streams?.open === 0;
    });
    const handle = (await metricsOf(running, "web")).provides.http?.handle;
    expect(handle?.kind === "rpc" && handle.streams?.errors).toEqual({ RACK_CANCELLED: 1 });
  });
});

describe("http-panel hosts", () => {
  test("README.md: a panel on loopback answers 403 for another host, and serves localhost and allowedHosts", async () => {
    const { port } = await panelRack({ allowedHosts: ["app.test"] });
    const status = (host: string) =>
      rawStatus(port, ["GET /web/greeting HTTP/1.1", `Host: ${host}`, "Connection: close"]);
    expect(await status("elsewhere.test")).toStartWith("HTTP/1.1 403");
    expect(await status(`127.0.0.1:${port}`)).toStartWith("HTTP/1.1 200");
    expect(await status(`localhost:${port}`)).toStartWith("HTTP/1.1 200");
    expect(await status("app.test")).toStartWith("HTTP/1.1 200");
  });

  test("README.md: a panel listens on 127.0.0.1 by default, and on 0.0.0.0 serves any host", async () => {
    const loopback = await panelRack();
    expect(loopback.url.hostname).toBe("127.0.0.1");
    const { running } = loopback;
    await running.stop();
    const { port } = await panelRack({ hostname: "0.0.0.0" });
    const status = await rawStatus(port, [
      "GET /web/greeting HTTP/1.1",
      "Host: elsewhere.test",
      "Connection: close",
    ]);
    expect(status).toStartWith("HTTP/1.1 200");
  });
});

describe("http-panel WebSocket", () => {
  test("README.md: a device refuses an upgrade with its response, or accepts it and names a subprotocol", async () => {
    const { url, port } = await panelRack();
    expect(await rawStatus(port, upgrade(port, "/chat?refuse"))).toStartWith("HTTP/1.1 403");
    const named = await socketTo(url, "/chat?protocol=chat", ["other", "chat"]);
    expect(named.ws.protocol).toBe("chat");
    // The head of the upgrade carries the device's headers.
    const head = await rawHead(port, [
      ...upgrade(port, "/chat?protocol=chat"),
      "Sec-WebSocket-Protocol: other, chat",
    ]);
    expect(head).toStartWith("HTTP/1.1 101");
    expect(head.toLowerCase()).toContain("x-chat: welcome");
    expect(head.toLowerCase()).toContain("sec-websocket-protocol: chat");
    // Without a protocol, Bun answers with the first one the client offered.
    const first = await socketTo(url, "/chat", ["other", "chat"]);
    expect(first.ws.protocol).toBe("other");
  });

  test("README.md: text and binary messages travel both ways", async () => {
    const { url } = await panelRack();
    const socket = await socketTo(url, "/chat?name=ann");
    expect(socket.messages[0]).toMatch(/^welcome ann \w+ http-panel:\w+:\d+$/);
    socket.ws.send("hi");
    await waitFor(() => socket.messages.some((m) => m.endsWith(" ann: hi")));
    socket.ws.send(new Uint8Array([1, 2, 3, 4, 5]));
    await waitFor(() => socket.messages.includes("5 bytes"));
    // The device closes it, with its own code.
    socket.ws.send("bye");
    expect(await socket.closed).toBe(4000);
  });

  test("README.md: a message over maxMessageSize closes the WebSocket with 1009", async () => {
    const { url } = await panelRack({ webSocket: { maxMessageSize: 1024 } });
    const socket = await socketTo(url, "/chat");
    socket.ws.send("x".repeat(2048));
    expect(await socket.closed).toBe(1009);
  });

  test("README.md: a client that reads too slowly is closed with 1013", async () => {
    const { url, port } = await panelRack();
    const client = await stalledSocket(port, "/chat", "flood 400");
    try {
      await waitFor(async () => (await chatState(url)).closes.some((c) => c.code === 1013));
    } finally {
      client.destroy();
    }
  });

  test("README.md: upgrades beyond maxConnections get 503, and the log says when refusing starts and ends", async () => {
    const { url, port, rec } = await panelRack({ webSocket: { maxConnections: 2 } });
    const first = await socketTo(url, "/chat");
    await socketTo(url, "/chat");
    expect(await rawStatus(port, upgrade(port, "/chat"))).toStartWith("HTTP/1.1 503");
    expect(await rawStatus(port, upgrade(port, "/chat"))).toStartWith("HTTP/1.1 503");
    const entries = (message: string) =>
      rec.logs.filter((e) => e.device === "http-panel" && e.message === message);
    expect(entries("refusing WebSocket upgrades")).toEqual([
      expect.objectContaining({ level: "warn", data: { maxConnections: 2 } }),
    ]);
    first.ws.close();
    await waitFor(() => entries("accepting WebSocket upgrades again").length === 1);
    await socketTo(url, "/chat");
  });

  test("README.md: a socket under a slow device has at most 16 messages in calls, which start in order", async () => {
    const { url } = await panelRack();
    const socket = await socketTo(url, "/chat");
    for (let i = 0; i < 200; i++) socket.ws.send(`seq ${i}`);
    await waitFor(async () => (await chatState(url)).starts.length === 200, 10_000);
    const state = await chatState(url);
    expect(state.starts).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(state.maxActive).toBeLessThanOrEqual(16);
    expect(state.maxActive).toBeGreaterThan(1);
  });

  test("README.md: a failed open or message call closes the socket, with 1013 for the codes that give 503", async () => {
    const { url } = await panelRack();
    const failing = await socketTo(url, "/chat");
    failing.ws.send("fail");
    expect(await failing.closed).toBe(1011);
    const busy = await socketTo(url, "/chat");
    busy.ws.send("busy");
    expect(await busy.closed).toBe(1013);
    // A failed open: the device's open handler throws before it sends anything.
    const target = new URL("/chat?name=fail-open", url);
    target.protocol = "ws:";
    const refused = new WebSocket(target.href);
    expect(
      await new Promise<number>((resolve) =>
        refused.addEventListener("close", (e) => resolve(e.code)),
      ),
    ).toBe(1011);
  });

  test("README.md: several panels share one port of a device, and each takes the events of its own sockets", async () => {
    const routes = { "/chat": "chat.http", "/chat/*": "chat.http" };
    const { rec } = await startRack({
      slots: {
        1: CHAT,
        2: httpPanel({ port: 0, routes }, { name: "public" }),
        3: httpPanel({ port: 0, routes }, { name: "admin" }),
      },
    });
    const a = await socketTo(rec.panelUrl("public"), "/chat?name=a");
    const b = await socketTo(rec.panelUrl("admin"), "/chat?name=b");
    expect(idOf(a.messages[0])).toStartWith("public:");
    expect(idOf(b.messages[0])).toStartWith("admin:");
    // One event, to both sockets.
    a.ws.send("all news");
    await waitFor(() => a.messages.includes("news") && b.messages.includes("news"));
    a.ws.send("ping");
    await waitFor(() => a.messages.some((m) => m.endsWith(": ping")));
    expect(a.messages.filter((m) => m === "news")).toHaveLength(1);
    expect(b.messages.filter((m) => m === "news")).toHaveLength(1);
  });

  test("README.md: the panel ignores events for sockets it no longer has", async () => {
    const { url, rec } = await panelRack();
    const gone = await socketTo(url, "/chat?name=gone");
    const stays = await socketTo(url, "/chat?name=stays");
    const goneId = idOf(gone.messages[0]);
    gone.ws.close();
    await waitFor(async () => (await chatState(url)).closes.some((c) => c.socket === goneId));
    stays.ws.send(`to ${goneId} lost`);
    stays.ws.send("to http-panel:earlier:1 lost");
    stays.ws.send(`to ${idOf(stays.messages[0])} here`);
    await waitFor(() => stays.messages.includes("here"));
    expect(stays.messages).not.toContain("lost");
    expect(panelErrors(rec)).toEqual([]);
  });
});

describe("http-panel swaps", () => {
  test("README.md: swapping the device behind a route keeps its WebSockets and their state", async () => {
    const { running, url } = await panelRack();
    const socket = await socketTo(url, "/chat?name=ann");
    const before = (await chatState(url)).instance;
    await running.swap("chat");
    socket.ws.send("hi");
    const reply = await waitFor(() => socket.messages.find((m) => m.endsWith(" ann: hi")));
    expect(reply.split(" ")[0]).not.toBe(before);
    // The new instance sends to it.
    socket.ws.send("all again");
    await waitFor(() => socket.messages.includes("again"));
    expect((await chatState(url)).sockets).toEqual([idOf(socket.messages[0])]);
  });

  test("README.md: swapping the panel keeps HTTP serving and closes WebSockets with 1012", async () => {
    const { running, get, url } = await panelRack();
    const socket = await socketTo(url, "/chat");
    await running.swap("http-panel");
    expect(await socket.closed).toBe(1012);
    expect(await (await get("/web/greeting")).text()).toBe("hello");
    await waitFor(async () => (await chatState(url)).closes.some((c) => c.code === 1012));
  });

  for (const how of ["reset", "restart"] as const) {
    test(`README.md: after a ${how} of the device behind a route, its sockets close with 1011, also ones that never send`, async () => {
      process.env.RACK42U_TEST_PANEL_SYNC_MS = "200";
      const { running, rec, url, get } = await panelRack();
      const talks = await socketTo(url, "/chat?name=talks");
      const quiet = await socketTo(url, "/chat?name=quiet");
      if (how === "reset") {
        await get("/chat/crash");
        await waitFor(() => rec.events.some((e) => e.type === "fault" && e.device === "chat"));
        await waitFor(() => statusOf(running, "chat").state === "online");
      } else {
        await running.restart("chat", { cascade: false });
      }
      talks.ws.send("still there?");
      expect(await talks.closed).toBe(1011);
      expect(await quiet.closed).toBe(1011);
    });
  }

  test("README.md: after a panel crash, the device runs its close handler for the panel's sockets with 1006", async () => {
    process.env.RACK42U_TEST_PANEL_SYNC_MS = "200";
    const routes = { "/chat": "chat.http", "/chat/*": "chat.http" };
    const { running, rec } = await startRack({
      slots: { 1: CHAT, 2: slot("./devices/crashing-panel.ts", { config: { port: 0, routes } }) },
    });
    const url = new URL(rec.panelUrl());
    const sockets = [await socketTo(url, "/chat"), await socketTo(url, "/chat")];
    const ids = sockets.map((s) => idOf(s.messages[0]));
    await running.call("http-panel.control", "crash", undefined);
    await Promise.all(sockets.map((s) => s.closed));
    await waitFor(() => rec.events.some((e) => e.type === "fault" && e.device === "http-panel"));
    await waitFor(() => statusOf(running, "http-panel").state === "online");
    // Each request reaches the device, which forgets the sockets of a panel instance that has
    // been silent for three of the panel's checks.
    const closes = await waitFor(async () => {
      const state = await chatState(url);
      return state.closes.length === 2 && state.closes;
    });
    expect(closes).toEqual(ids.map((socket) => ({ socket, code: 1006 })));
  });

  test("a socket that opens or closes while the panel checks its sockets stays as it is", async () => {
    process.env.RACK42U_TEST_PANEL_SYNC_MS = "100";
    const { url } = await panelRack();
    const open = [];
    for (let i = 0; i < 10; i++) {
      open.push(await socketTo(url, "/chat"));
      await Bun.sleep(15);
    }
    const closing = open.splice(0, 5);
    for (const socket of closing) {
      socket.ws.close(1000);
      await Bun.sleep(15);
    }
    await Bun.sleep(300);
    expect(open.map((s) => s.ws.readyState)).toEqual(open.map(() => WebSocket.OPEN));
    expect((await chatState(url)).closes.map((c) => c.code)).toEqual([
      1000, 1000, 1000, 1000, 1000,
    ]);
  });
});

/** A directory with copies of the test certificates, which a test may overwrite. */
async function certificates() {
  const dir = await mkdtemp(join(tmpdir(), "rack42u-test-certs-"));
  temporary.push(dir);
  for (const name of ["one", "two", "three"]) {
    for (const ext of ["crt", "key"]) {
      await copyFile(join(FIXTURES, "certs", `${name}.${ext}`), join(dir, `${name}.${ext}`));
    }
  }
  const path = (file: string) => join(dir, file);
  /** Copies one test file over another. */
  const put = (from: string, to: string) => copyFile(join(FIXTURES, "certs", from), path(to));
  return { path, put };
}

const entriesOf = (rec: { logs: { device?: string; message: string; time: number }[] }) => ({
  replaced: () =>
    rec.logs.filter((e) => e.device === "http-panel" && e.message === "certificates replaced"),
  rejected: () =>
    rec.logs.filter((e) => e.device === "http-panel" && e.message === "certificates rejected"),
});

describe("http-panel certificates", () => {
  test("README.md: with SNI, a pair that changed is replaced while one that doesn't load keeps its old version", async () => {
    const { path, put } = await certificates();
    const { port, rec } = await panelRack({
      tls: [
        { cert: path("one.crt"), key: path("one.key"), serverName: "one.test" },
        { cert: path("two.crt"), key: path("two.key"), serverName: "two.test" },
      ],
      certificateCheck: 1,
    });
    expect(await certificateOf(port, "one.test")).toBe("one.test");
    await put("three.crt", "one.crt");
    await put("three.key", "one.key");
    await put("one.key", "two.key");
    await waitFor(() => entriesOf(rec).replaced().length === 1);
    expect(await certificateOf(port, "one.test")).toBe("three.test");
    expect(await certificateOf(port, "two.test")).toBe("two.test");
    // Unknown names get the first pair.
    expect(await certificateOf(port, "other.test")).toBe("three.test");
  });

  test("README.md: a replaced certificate serves new connections, while connections opened before keep working", async () => {
    const { path, put } = await certificates();
    const { running, port, url, rec } = await panelRack({
      tls: { cert: path("one.crt"), key: path("one.key") },
      certificateCheck: 1,
    });
    expect(url.protocol).toBe("https:");
    expect(statusOf(running, "http-panel").listeners[0]?.certificates).toEqual([
      { subject: "CN=one.test", notAfter: expect.any(Number) },
    ]);
    const socket = await socketTo(url, "/chat?name=early");
    await put("two.crt", "one.crt");
    await put("two.key", "one.key");
    await waitFor(() => entriesOf(rec).replaced().length === 1);
    expect(await certificateOf(port)).toBe("two.test");
    await waitFor(
      () =>
        statusOf(running, "http-panel").listeners[0]?.certificates[0]?.subject === "CN=two.test",
    );
    socket.ws.send("still there?");
    await waitFor(() => socket.messages.some((m) => m.endsWith(" early: still there?")));
  });

  test("README.md: a pair that doesn't load leaves the old one serving, with an error at the second check, once", async () => {
    const { path, put } = await certificates();
    const { port, rec } = await panelRack({
      tls: { cert: path("one.crt"), key: path("one.key") },
      certificateCheck: 1,
    });
    const written = Date.now();
    await put("two.key", "one.key");
    const [entry] = await waitFor(() => {
      const rejected = entriesOf(rec).rejected();
      return rejected.length > 0 && rejected;
    });
    // The first check after the write found the pair, and the second logged it.
    expect((entry?.time as number) - written).toBeGreaterThan(900);
    expect(entry).toMatchObject({ level: "error", data: { cert: path("one.crt") } });
    expect(await certificateOf(port)).toBe("one.test");
    await Bun.sleep(2_500);
    expect(entriesOf(rec).rejected()).toHaveLength(1);
  }, 15_000);

  test("README.md: a renewal that writes the certificate and the key one after the other loads without an error", async () => {
    const { path, put } = await certificates();
    const { port, rec } = await panelRack({
      tls: { cert: path("one.crt"), key: path("one.key") },
      certificateCheck: 2,
    });
    // The checks run 2 s, 4 s, and 6 s after the panel started: one finds only the certificate
    // written, and the next finds both.
    const started = performance.now();
    const at = (ms: number) => Bun.sleep(Math.max(0, started + ms - performance.now()));
    await at(3_000);
    await put("three.crt", "one.crt");
    await at(5_000);
    await put("three.key", "one.key");
    await waitFor(() => entriesOf(rec).replaced().length === 1, 5_000);
    expect(await certificateOf(port)).toBe("three.test");
    expect(entriesOf(rec).rejected()).toEqual([]);
    expect(panelErrors(rec)).toEqual([]);
  }, 15_000);

  test("README.md: a pair that doesn't load at start fails the panel's powerOn", async () => {
    const error = await errorOf(
      panelRack({ tls: { cert: "certs/one.crt", key: "certs/two.key" } }),
    );
    expect(error.code).toBe("RACK_HOOK_FAILED");
  });
});

describe("http-panel configuration", () => {
  test("README.md: the defaults of the panel's configuration", () => {
    expect(v.parse(PanelConfig, { port: 0, routes: {} })).toEqual({
      hostname: "127.0.0.1",
      port: 0,
      routes: {},
      maxBodySize: MiB,
      streamThreshold: 256 * 1024,
      idleTimeout: 10,
      certificateCheck: 60,
      webSocket: { maxMessageSize: MiB, maxConnections: 10_000 },
    });
    // The panel checks its WebSockets with the devices behind it every 30 s.
    expect(SYNC_MS).toBe(30_000);
  });

  test("README.md: a route to a device that isn't below the panel fails with RACK_MANIFEST", async () => {
    const above = await errorOf(
      startRack({ slots: { 1: httpPanel({ port: 0, routes: { "/web/*": "web.http" } }), 2: WEB } }),
    );
    expect(above.code).toBe("RACK_MANIFEST");
    expect(above.message).toContain("breaks the gravity rule");
    const unknown = await errorOf(
      startRack({ slots: { 1: WEB, 2: httpPanel({ port: 0, routes: { "/x": "ghost.http" } }) } }),
    );
    expect(unknown.code).toBe("RACK_MANIFEST");
    expect(unknown.message).toContain(
      "patch http-panel.ghost_http (http/v2) -> ghost.http: no device ghost",
    );
  });

  test("README.md: a configuration that doesn't validate fails with RACK_INVALID_CONFIG", async () => {
    const port = await errorOf(
      startRack({ slots: { 1: httpPanel({ port: 70_000, routes: {} }) } }),
    );
    expect(port.code).toBe("RACK_INVALID_CONFIG");
    const names = await errorOf(
      startRack({
        slots: {
          1: slot("./devices/web.ts", { name: "a-b" }),
          2: slot("./devices/web.ts", { name: "a_b" }),
          3: httpPanel({ port: 0, routes: { "/1": "a-b.http", "/2": "a_b.http" } }),
        },
      }),
    );
    expect([names.code, names.message]).toEqual([
      "RACK_INVALID_CONFIG",
      expect.stringContaining("the routes to a-b.http and a_b.http give one need name, a_b_http"),
    ]);
  });

  test("README.md: the panel names each need after its address", async () => {
    const { running, rec } = await startRack({
      slots: {
        1: slot("./devices/web.ts", { name: "2fa" }),
        2: httpPanel({ port: 0, routes: { "/web/*": "2fa.http" } }),
      },
    });
    expect(await (await fetch(new URL("/web/greeting", rec.panelUrl()))).text()).toBe("hello");
    expect(Object.keys((await metricsOf(running, "http-panel")).needs)).toEqual(["_2fa_http"]);
  });

  test("README.md: in a scanned rack, the panel's routes pull in the models they name", async () => {
    const app = await tempApp(["connectors.ts", "devices/web.ts", "devices/counter.ts"], FIXTURES);
    apps.push(app);
    const panel = httpPanel({ port: 0, routes: { "/web/*": "web.http" } });
    const { running, rec } = await startRack(
      { devices: ["./devices", panel], roots: ["http-panel"] },
      { baseDir: app.dir },
    );
    expect(running.status().map((s) => s.name)).toEqual(["web", "http-panel"]);
    expect(await (await fetch(new URL("/web/greeting", rec.panelUrl()))).text()).toBe("hello");
    // A panel left out of the roots is unused.
    const report = await planRack(rack("test", { devices: ["./devices", panel], roots: ["web"] }), {
      baseDir: app.dir,
      logger: () => {},
    });
    expect(report.unused).toEqual(["counter", "http-panel"]);
  });

  test("README.md: edited routes and a new port replace the panel without a restart", async () => {
    const { running, rec } = await startRack({
      slots: { 1: WEB, 2: httpPanel({ port: 0, routes: { "/web/*": "web.http" } }) },
    });
    const before = new URL(rec.panelUrl());
    const port = await freePort();
    const results = await running.reload(
      rack("test", {
        slots: { 1: WEB, 2: httpPanel({ port, routes: { "/web/greeting": "web.http" } }) },
      }),
    );
    expect(results).toEqual([expect.objectContaining({ device: "http-panel", mode: "hot" })]);
    expect(results[0]?.error).toBeUndefined();
    const after = new URL(rec.panelUrl());
    expect(Number(after.port)).toBe(port);
    expect(await (await fetch(new URL("/web/greeting", after))).text()).toBe("hello");
    expect((await fetch(new URL("/web/echo", after))).status).toBe(404);
    expect(rec.logs).toContainEqual(
      expect.objectContaining({
        device: "http-panel",
        message: "listener closed",
        data: { url: before.href },
      }),
    );
  });
});

describe("http-panel observation", () => {
  test("README.md: the panel's needs count the calls per route target, and status() shows its listener", async () => {
    const { running, get, url, port } = await panelRack();
    await get("/web/greeting");
    await get("/web/boom");
    await get("/chat/state");
    // A body over streamThreshold, 256 KiB by default, streams, which the need's counters show.
    await get("/web/upload", { method: "POST", body: new Uint8Array(300 * 1024) });
    // Answers for which no call reached a device count nowhere.
    await get("/elsewhere");
    const raw = (host: string, extra: string[] = []) =>
      rawStatus(port, [
        "POST /web/upload HTTP/1.1",
        `Host: ${host}`,
        ...extra,
        "Connection: close",
      ]);
    expect(await raw("elsewhere.test")).toStartWith("HTTP/1.1 403");
    expect(await raw(`127.0.0.1:${port}`, [`Content-Length: ${2 * MiB}`])).toStartWith(
      "HTTP/1.1 413",
    );
    const { needs } = await metricsOf(running, "http-panel");
    expect(needs.web_http?.handle).toMatchObject({
      calls: 3,
      ok: 2,
      errors: { RACK_DEVICE_FAULT: 1 },
      streams: { opened: 1, open: 0, bytesSent: 300 * 1024, errors: {} },
    });
    expect(needs.chat_http?.handle).toMatchObject({ calls: 1, ok: 1, errors: {} });
    const socket = await socketTo(url, "/chat");
    await waitFor(() => statusOf(running, "http-panel").listeners[0]?.webSockets === 1);
    expect(statusOf(running, "http-panel").listeners).toEqual([
      expect.objectContaining({ url: url.href, certificates: [], webSockets: 1 }),
    ]);
    socket.ws.close();
  });
});

const CALL: CallContext = {
  signal: new AbortController().signal,
  deadline: Number.POSITIVE_INFINITY,
  transfer() {},
};

/** An emitter that records the events a handler emits. */
function recorder() {
  const sent: unknown[] = [];
  const closed: unknown[] = [];
  const emit = {
    send: async (payload: unknown) => {
      sent.push(payload);
    },
    close: async (payload: unknown) => {
      closed.push(payload);
    },
  } as unknown as PortEmitter<typeof Http.members>;
  return { emit, sent, closed };
}

/** A handler whose sockets record how they closed. */
function chatHandler() {
  const { emit, sent, closed } = recorder();
  const closes: [string, number][] = [];
  const handler = httpHandler<string>(
    {
      fetch: (request, server) =>
        server.upgrade(request, { data: new URL(request.url).searchParams.get("name") ?? "" })
          ? undefined
          : new Response("plain"),
      websocket: {
        message: (ws, data) => ws.send(`${ws.data}: ${String(data)}`),
        close: (ws, code) => {
          closes.push([ws.id, code]);
        },
      },
    },
    emit,
  );
  const open = async (socket: string, name = "x") => {
    const request = {
      method: "GET",
      url: `http://rack.local/chat?name=${name}`,
      headers: [] as [string, string][],
      params: {},
      body: null,
      socket,
    };
    expect(await handler.handle(request, CALL)).toEqual({ upgrade: {} });
    await handler.opened({ socket }, CALL);
  };
  return { handler, open, closes, sent, closed };
}

const SILENCE = 90_000;

describe("http/v2 and httpHandler", () => {
  test("README.md: http/v2 has the members handle, opened, message, closed, sockets, send, and close", () => {
    expect(describeConnector(Http)).toEqual({
      id: "http/v2",
      members: {
        handle: "rpc",
        opened: "rpc",
        message: "rpc",
        closed: "rpc",
        sockets: "rpc",
        send: "event",
        close: "event",
      },
    });
  });

  test("README.md: httpHandler turns a fetch function into an http/v2 implementation", async () => {
    const handler = httpHandler(async (request) => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      const body = `${request.method} ${new URL(request.url).pathname} ${await request.text()}`;
      return new Response(body, { status: 201, headers });
    });
    const output = await handler.handle(
      {
        method: "PUT",
        url: "http://rack.local/things",
        headers: [["content-type", "text/plain"]],
        params: {},
        body: new TextEncoder().encode("body"),
      },
      CALL,
    );
    if (!("status" in output)) throw new Error("not a response");
    expect(output.status).toBe(201);
    expect(new TextDecoder().decode(output.body as Uint8Array)).toBe("PUT /things body");
    expect(output.headers).toContainEqual(["content-type", "text/plain"]);
    expect(output.headers.filter(([name]) => name === "set-cookie")).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
  });

  test("README.md: httpHandler passes call.signal to the request", async () => {
    const controller = new AbortController();
    const handler = httpHandler(
      (request) =>
        new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(new Response("aborted")));
        }),
    );
    const pending = handler.handle(
      { method: "GET", url: "http://rack.local/", headers: [], params: {}, body: null },
      { ...CALL, signal: controller.signal },
    );
    controller.abort();
    const output = await pending;
    if (!("status" in output)) throw new Error("not a response");
    expect(new TextDecoder().decode(output.body as Uint8Array)).toBe("aborted");
  });

  test("README.md: a response body that ends at once within streamThreshold goes as bytes, moved, and any other streams", async () => {
    const fetch = (request: Request) => {
      const size = Number(new URL(request.url).searchParams.get("size"));
      if (size > 0) return new Response(new Uint8Array(size));
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await Bun.sleep(5);
            controller.enqueue(new TextEncoder().encode("late"));
            controller.close();
          },
        }),
      );
    };
    const moved: ArrayBuffer[] = [];
    const call: CallContext = { ...CALL, transfer: (...buffers) => moved.push(...buffers) };
    const bodyOf = async (handler: ReturnType<typeof httpHandler>, size: number) => {
      const request = { method: "GET", url: `http://r/?size=${size}`, headers: [], params: {} };
      const output = await handler.handle({ ...request, body: null }, call);
      return "status" in output ? output.body : undefined;
    };
    // The default is 16 MiB; a body of 1 KiB or more is moved, and a smaller one copied.
    const plain = httpHandler(fetch);
    expect(await bodyOf(plain, 1000)).toBeInstanceOf(Uint8Array);
    expect(moved).toEqual([]);
    const whole = await bodyOf(plain, 16 * MiB);
    expect(whole).toBeInstanceOf(Uint8Array);
    expect(moved).toEqual([(whole as Uint8Array).buffer as ArrayBuffer]);
    const large = await bodyOf(plain, 16 * MiB + 1);
    expect(large).toBeInstanceOf(ReadableStream);
    expect((await new Response(large as ReadableStream).arrayBuffer()).byteLength).toBe(
      16 * MiB + 1,
    );
    const slow = await bodyOf(plain, 0);
    expect(slow).toBeInstanceOf(ReadableStream);
    expect(await new Response(slow as ReadableStream).text()).toBe("late");
    // A handler with its own threshold.
    const small = httpHandler({ fetch, streamThreshold: 1000 });
    expect(await bodyOf(small, 1000)).toBeInstanceOf(Uint8Array);
    expect(await bodyOf(small, 1001)).toBeInstanceOf(ReadableStream);
    // With 0, every body that has bytes streams.
    expect(await bodyOf(httpHandler({ fetch, streamThreshold: 0 }), 1)).toBeInstanceOf(
      ReadableStream,
    );
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => httpHandler({ fetch, streamThreshold: bad })).toThrow(
        expect.objectContaining({ code: "RACK_INVALID_INPUT" }),
      );
    }
  });

  test("README.md: a request body that streams reaches fetch as request.body", async () => {
    const handler = httpHandler(
      async (request) => new Response(String((await request.bytes()).length)),
    );
    const output = await handler.handle(
      {
        method: "POST",
        url: "http://rack.local/",
        headers: [],
        params: {},
        body: new Response(new Uint8Array(200_000)).body as ReadableStream<Uint8Array>,
      },
      CALL,
    );
    if (!("status" in output)) throw new Error("not a response");
    expect(new TextDecoder().decode(output.body as Uint8Array)).toBe("200000");
  });

  test("README.md: an upgrade that fetch doesn't accept gets its response, and one without WebSocket handlers fails", async () => {
    const request = {
      method: "GET",
      url: "http://rack.local/",
      headers: [] as [string, string][],
      params: {},
      body: null,
      socket: "p:1:1",
    };
    const plain = await httpHandler(() => new Response("plain")).handle(request, CALL);
    expect("status" in plain && plain.status).toBe(200);
    const lacking = httpHandler({
      fetch: (r, server) => (server.upgrade(r) ? undefined : new Response("no")),
    });
    const error = await errorOf(Promise.resolve(lacking.handle(request, CALL)));
    expect(error.code).toBe("RACK_INVALID_OUTPUT");
  });

  test("README.md: sockets send and close through the port's events, and a message for an unknown socket closes it with 1011", async () => {
    const { handler, open, sent, closed } = chatHandler();
    await open("p:1:1", "ann");
    await handler.message({ socket: "p:1:1", data: "hi" }, CALL);
    expect(sent).toEqual([{ socket: "p:1:1", data: "ann: hi" }]);
    await handler.message({ socket: "p:1:9", data: "hi" }, CALL);
    expect(closed).toEqual([{ socket: "p:1:9", code: 1011, reason: "unknown socket" }]);
  });

  test("README.md: sockets answers with the ids the device doesn't know, and drops a socket that two calls in a row left out", async () => {
    const { handler, open, closes } = chatHandler();
    await open("p:1:1");
    await open("p:1:2");
    expect(await handler.sockets({ instance: "p:1", open: ["p:1:1", "p:1:9"] }, CALL)).toEqual({
      unknown: ["p:1:9"],
    });
    // p:1:2 opened after the panel listed its sockets, as when a check overlaps an open.
    expect(closes).toEqual([]);
    await handler.sockets({ instance: "p:1", open: ["p:1:1"] }, CALL);
    expect(closes).toEqual([["p:1:2", 1006]]);
    expect(handler.list().map((s) => s.socket)).toEqual(["p:1:1"]);
  });

  test("README.md: a device forgets the sockets of a panel instance that made no call for 90 s", async () => {
    const { handler, open, closes } = chatHandler();
    const now = Date.now();
    await open("p:1:1");
    await open("p:2:1");
    setSystemTime(now + SILENCE - 1_000);
    await handler.sockets({ instance: "p:2", open: ["p:2:1"] }, CALL);
    expect(closes).toEqual([]);
    setSystemTime(now + SILENCE + 1_000);
    // Any call checks, a plain request too.
    await handler.handle(
      { method: "GET", url: "http://rack.local/", headers: [], params: {}, body: null },
      CALL,
    );
    expect(closes).toEqual([["p:1:1", 1006]]);
    expect(handler.list().map((s) => s.socket)).toEqual(["p:2:1"]);
  });

  test("README.md: list() and restore() carry sockets and their data to a new instance, whose silence counts from restore", async () => {
    const first = chatHandler();
    await first.open("p:1:1", "ann");
    const list = first.handler.list();
    expect(list).toEqual([{ socket: "p:1:1", data: "ann" }]);
    const now = Date.now();
    setSystemTime(now + SILENCE * 2);
    const second = chatHandler();
    second.handler.restore(list);
    // The socket opened two silences ago, but the new instance counts from its restore.
    setSystemTime(now + SILENCE * 3 - 1_000);
    await second.handler.sockets({ instance: "p:2", open: [] }, CALL);
    expect(second.closes).toEqual([]);
    await second.handler.message({ socket: "p:1:1", data: "back" }, CALL);
    expect(second.sent).toEqual([{ socket: "p:1:1", data: "ann: back" }]);
    setSystemTime(now + SILENCE * 4);
    await second.handler.sockets({ instance: "p:2", open: [] }, CALL);
    expect(second.closes).toEqual([["p:1:1", 1006]]);
  });

  test("README.md: Http and httpHandler come from rack42u/std, not rack42u", async () => {
    const core = await import("rack42u");
    expect("Http" in core).toBe(false);
    expect("httpHandler" in core).toBe(false);
  });
});
