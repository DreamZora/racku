/**
 * Tests of `examples/net-tool`'s rack side, which run on Linux, macOS, and Windows: `net` and
 * `ui` on the bench, the whole rack through its panel, and the window's codec. The Tauri shell
 * and the window are checked by hand, as the example's README lists.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#tests
 * @decision .agents/decisions/261120_203926-net-tool-installers.md#tests
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RackError, type SlotStatus } from "racku";
import { type Bench, bench, stub } from "racku/bench";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToText,
  HexError,
  hexToBytes,
  textToBytes,
} from "../examples/net-tool/app/src/codec.ts";
import { Connection, type ConnectionState } from "../examples/net-tool/app/src/connection.ts";
import { KEPT, KEPT_BYTES, keep } from "../examples/net-tool/app/src/kept.ts";
import { Net } from "../examples/net-tool/connectors.ts";
import {
  Cli,
  codeOf,
  ROOT,
  type TempApp,
  tempApp,
  useControlDir,
  WINDOWS,
  waitFor,
} from "./fixtures/app.ts";

const NET_TOOL = join(ROOT, "examples", "net-tool");
const TOKEN = "0123456789abcdef".repeat(4);
const ORIGIN = "http://localhost:5173";
const UI_CONFIG = { token: TOKEN, origins: [ORIGIN] };

const apps: TempApp[] = [];
const processes: Cli[] = [];
const servers: { stop(closeActive?: boolean): void }[] = [];
useControlDir();

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** A copy of the example's rack side, as the base directory of a bench or a rack. */
async function netTool(): Promise<TempApp> {
  const app = await tempApp(["connectors.ts", "devices", "rack.ts"], NET_TOOL);
  apps.push(app);
  return app;
}

/** A TCP server on 127.0.0.1 that sends back what it gets. */
function echoServer() {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
    },
  });
  servers.push(server);
  return server;
}

type Payload = Record<string, unknown>;

/** Waits for an event of the device on a bench that `match` accepts, and returns its payload. */
function eventOf(device: Bench, event: string, match: (payload: Payload) => boolean = () => true) {
  return waitFor(
    () =>
      device.events.find(
        (recorded) => recorded.event === event && match(recorded.payload as Payload),
      )?.payload as Payload | undefined,
  );
}

describe("net on the bench", () => {
  test("a TCP client reaches a server the test opens, and gets its bytes back", async () => {
    const app = await netTool();
    const server = echoServer();
    await using net = await bench("./devices/net.ts", { baseDir: app.dir });
    const opened = await net.call<{ id: number; remote: { host: string; port: number } }>(
      "net",
      "open",
      { kind: "tcp-client", host: "127.0.0.1", port: server.port },
    );
    expect(opened.remote).toEqual({ host: "127.0.0.1", port: server.port });
    await eventOf(net, "opened", (payload) => payload.id === opened.id);
    expect(await net.call("net", "send", { id: opened.id, data: textToBytes("hello") })).toEqual({
      sent: 5,
    });
    const data = await eventOf(net, "data", (payload) => payload.id === opened.id);
    expect(bytesToText(data.data as Uint8Array)).toBe("hello");
    expect(await net.call("net", "list", undefined)).toEqual([
      expect.objectContaining({
        id: opened.id,
        kind: "tcp-client",
        sent: 5,
        received: 5,
        events: 1,
      }),
    ]);
    await net.call("net", "close", { id: opened.id });
    await eventOf(net, "closed", (payload) => payload.id === opened.id);
    expect(await net.call("net", "list", undefined)).toEqual([]);
  });

  // @doc docs/guides/listeners.md#other-sockets
  test("a TCP server accepts the test's connection, whose bytes go both ways", async () => {
    const app = await netTool();
    await using net = await bench("./devices/net.ts", { baseDir: app.dir });
    const server = await net.call<{ id: number; local: { port: number } }>("net", "open", {
      kind: "tcp-server",
      host: "127.0.0.1",
      port: 0,
    });
    let received = "";
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.local.port,
      socket: {
        data(_socket, data) {
          received += new TextDecoder().decode(data);
        },
      },
    });
    const accepted = await eventOf(net, "opened", (payload) => payload.server === server.id);
    const connection = accepted.id as number;
    client.write("ping");
    const data = await eventOf(net, "data", (payload) => payload.id === connection);
    expect(bytesToText(data.data as Uint8Array)).toBe("ping");
    await net.call("net", "send", { id: connection, data: textToBytes("pong") });
    await waitFor(() => received === "pong");
    expect(await codeOf(net.call("net", "send", { id: server.id, data: textToBytes("x") }))).toBe(
      "RACK_INVALID_INPUT",
    );
    const listed = await net.call<{ id: number; kind: string; server?: number }[]>(
      "net",
      "list",
      undefined,
    );
    expect(listed.map(({ id, kind, server }) => ({ id, kind, server }))).toEqual([
      { id: server.id, kind: "tcp-server", server: undefined },
      { id: connection, kind: "tcp-connection", server: server.id },
    ]);
    await net.call("net", "close", { id: server.id });
    await eventOf(net, "closed", (payload) => payload.id === connection);
    await eventOf(net, "closed", (payload) => payload.id === server.id);
    client.end();
  });

  // @doc docs/guides/listeners.md#other-sockets
  test("UDP goes both ways, and a send needs an address and a datagram's size", async () => {
    const app = await netTool();
    await using net = await bench("./devices/net.ts", { baseDir: app.dir });
    const received: string[] = [];
    const peer = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(_socket, data) {
          received.push(new TextDecoder().decode(data));
        },
      },
    });
    const udp = await net.call<{ id: number; local: { host: string; port: number } }>(
      "net",
      "open",
      { kind: "udp", host: "127.0.0.1", port: 0 },
    );
    const to = { host: "127.0.0.1", port: peer.port };
    await net.call("net", "send", { id: udp.id, data: textToBytes("to the peer"), to });
    await waitFor(() => received.includes("to the peer"));
    peer.send("to net", udp.local.port, "127.0.0.1");
    const data = await eventOf(net, "data", (payload) => payload.id === udp.id);
    expect(bytesToText(data.data as Uint8Array)).toBe("to net");
    expect(data.from).toEqual({ host: "127.0.0.1", port: peer.port });
    expect(await codeOf(net.call("net", "send", { id: udp.id, data: textToBytes("x") }))).toBe(
      "RACK_INVALID_INPUT",
    );
    const big = new Uint8Array(65_508);
    expect(await codeOf(net.call("net", "send", { id: udp.id, data: big, to }))).toBe(
      "RACK_INVALID_INPUT",
    );
    peer.close();
  });

  test("a TCP send beyond 1 MiB waiting for a peer that doesn't read fails with RACK_OVERLOADED", async () => {
    const app = await netTool();
    const peer = createServer((socket) => socket.pause());
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    servers.push({ stop: () => peer.close() });
    const { port } = peer.address() as AddressInfo;
    await using net = await bench("./devices/net.ts", { baseDir: app.dir });
    const client = await net.call<{ id: number }>("net", "open", {
      kind: "tcp-client",
      host: "127.0.0.1",
      port,
    });
    const chunk = new Uint8Array(64 * 1024);
    let code: string | undefined;
    // The system's buffers take some megabytes first, which differ from system to system.
    for (let sends = 0; sends < 2_000 && code === undefined; sends++) {
      code = await codeOf(net.call("net", "send", { id: client.id, data: chunk })).catch(
        () => undefined,
      );
    }
    expect(code).toBe("RACK_OVERLOADED");
  });

  test("maxSockets, the TCP send limit, and failures to connect, listen, or find a socket", async () => {
    const app = await netTool();
    const server = echoServer();
    await using net = await bench("./devices/net.ts", {
      baseDir: app.dir,
      config: { maxSockets: 2 },
    });
    const first = await net.call<{ id: number; local: { port: number } }>("net", "open", {
      kind: "tcp-server",
      host: "127.0.0.1",
      port: 0,
    });
    expect(
      await codeOf(
        net.call("net", "open", { kind: "tcp-server", host: "127.0.0.1", port: first.local.port }),
      ),
    ).toBe("NET_LISTEN_FAILED");
    const client = await net.call<{ id: number }>("net", "open", {
      kind: "tcp-client",
      host: "127.0.0.1",
      port: server.port,
    });
    expect(await codeOf(net.call("net", "open", { kind: "udp", host: "127.0.0.1", port: 0 }))).toBe(
      "RACK_OVERLOADED",
    );
    const over = new Uint8Array(64 * 1024 + 1);
    expect(await codeOf(net.call("net", "send", { id: client.id, data: over }))).toBe(
      "RACK_INVALID_INPUT",
    );
    expect(await codeOf(net.call("net", "close", { id: 99 }))).toBe("NET_UNKNOWN_SOCKET");
    await net.call("net", "close", { id: first.id });
    const closedPort = first.local.port;
    expect(
      await codeOf(
        net.call("net", "open", { kind: "tcp-client", host: "127.0.0.1", port: closedPort }),
      ),
    ).toBe("NET_CONNECT_FAILED");
  });
});

describe("ui on the bench", () => {
  /** A stub of net/v1 that records its calls and fails `open` for port 1. */
  function netStub() {
    return stub(Net, {
      open: ({ kind, host, port }) => {
        if (port === 1) throw new RackError("NET_CONNECT_FAILED", "connection refused");
        return {
          id: 7,
          local: { host, port: 50_000 },
          ...(kind === "tcp-client" ? { remote: { host, port } } : {}),
        };
      },
      send: ({ data }) => ({ sent: data.byteLength }),
      list: () => [
        {
          id: 7,
          kind: "tcp-client" as const,
          local: { host: "127.0.0.1", port: 50_000 },
          sent: 0,
          received: 2,
          events: 2,
        },
      ],
    });
  }

  /** The panel's call for a WebSocket upgrade, with these headers. */
  function upgrade(ui: Bench, socket: string, headers: [string, string][]) {
    return ui.call("http", "handle", {
      method: "GET",
      url: "http://127.0.0.1:41000/ws",
      headers: [["upgrade", "websocket"], ...headers],
      params: {},
      body: null,
      socket,
    });
  }

  const allowed: [string, string][] = [
    ["origin", ORIGIN],
    ["sec-websocket-protocol", `net-tool, token.${TOKEN}`],
  ];

  /** Opens a window's WebSocket as the panel would. */
  async function connect(ui: Bench, socket: string) {
    expect(await upgrade(ui, socket, allowed)).toEqual({ upgrade: { protocol: "net-tool" } });
    await ui.call("http", "opened", { socket });
  }

  /** What `ui` sent to a socket, parsed, once `match` accepts it. */
  function sentTo(ui: Bench, socket: string, match: (message: Payload) => boolean) {
    return waitFor(() => {
      for (const recorded of ui.events) {
        const payload = recorded.payload as { socket: string | string[]; data: string };
        const targets = Array.isArray(payload.socket) ? payload.socket : [payload.socket];
        if (recorded.event !== "send" || !targets.includes(socket)) continue;
        const message = JSON.parse(payload.data) as Payload;
        if (match(message)) return message;
      }
      return undefined;
    });
  }

  test("the upgrade needs an allowed Origin and the token, offered as a subprotocol", async () => {
    const app = await netTool();
    await using ui = await bench("./devices/ui.ts", {
      baseDir: app.dir,
      config: UI_CONFIG,
      needs: { net: netStub() },
    });
    const statusOf = async (headers: [string, string][]) =>
      ((await upgrade(ui, "p:1:9", headers)) as { status?: number }).status;
    expect(
      await statusOf([["origin", "https://evil.example"], allowed[1] as [string, string]]),
    ).toBe(403);
    expect(
      await statusOf([
        ["origin", ORIGIN],
        ["sec-websocket-protocol", "net-tool"],
      ]),
    ).toBe(403);
    expect(
      await statusOf([
        ["origin", ORIGIN],
        ["sec-websocket-protocol", `net-tool, token.${"f".repeat(64)}`],
      ]),
    ).toBe(403);
    expect(await upgrade(ui, "p:1:1", allowed)).toEqual({ upgrade: { protocol: "net-tool" } });
  });

  test("commands get their answers, and net's events go to every window, also after a hot swap", async () => {
    const app = await netTool();
    const net = netStub();
    await using ui = await bench("./devices/ui.ts", {
      baseDir: app.dir,
      config: UI_CONFIG,
      needs: { net },
    });
    await connect(ui, "p:1:1");
    await connect(ui, "p:1:2");
    const command = (socket: string, message: unknown) =>
      ui.call("http", "message", { socket, data: JSON.stringify(message) });

    await command("p:1:1", {
      id: 1,
      op: "open",
      input: { kind: "tcp-client", host: "h", port: 9 },
    });
    expect(await sentTo(ui, "p:1:1", (message) => message.id === 1)).toEqual({
      id: 1,
      ok: true,
      value: { id: 7, local: { host: "h", port: 50_000 }, remote: { host: "h", port: 9 } },
    });
    await command("p:1:1", {
      id: 2,
      op: "send",
      input: { id: 7, data: bytesToBase64(textToBytes("hi")) },
    });
    expect(await sentTo(ui, "p:1:1", (message) => message.id === 2)).toEqual({
      id: 2,
      ok: true,
      value: { sent: 2 },
    });
    expect(net.calls.at(-1)?.input).toEqual({ id: 7, data: textToBytes("hi") });
    await command("p:1:2", {
      id: 3,
      op: "open",
      input: { kind: "tcp-client", host: "h", port: 1 },
    });
    expect(await sentTo(ui, "p:1:2", (message) => message.id === 3)).toEqual({
      id: 3,
      ok: false,
      error: { code: "NET_CONNECT_FAILED", message: "connection refused" },
    });
    await command("p:1:2", { id: 4, op: "jump" });
    expect(await sentTo(ui, "p:1:2", (message) => message.id === null)).toMatchObject({
      ok: false,
      error: { code: "RACK_INVALID_INPUT" },
    });

    await net.emit.data({ id: 7, data: textToBytes("yo") });
    for (const socket of ["p:1:1", "p:1:2"]) {
      expect(await sentTo(ui, socket, (message) => message.event === "data")).toEqual({
        event: "data",
        id: 7,
        data: bytesToBase64(textToBytes("yo")),
      });
    }

    await ui.swap();
    await command("p:1:2", { id: 5, op: "list" });
    expect(await sentTo(ui, "p:1:2", (message) => message.id === 5)).toEqual({
      id: 5,
      ok: true,
      value: [expect.objectContaining({ id: 7, events: 2, delivered: 1 })],
    });
    await net.emit.closed({ id: 7 });
    for (const socket of ["p:1:1", "p:1:2"]) {
      expect(await sentTo(ui, socket, (message) => message.event === "closed")).toEqual({
        event: "closed",
        id: 7,
      });
    }
    expect(ui.events.some((recorded) => recorded.event === "close")).toBe(false);
  });
});

describe("the net tool's rack", () => {
  test("a window's WebSocket opens a TCP connection to a test server and gets its bytes back", async () => {
    const app = await netTool();
    const server = echoServer();
    // The shell of a debug build sets NET_TOOL_DEV, so that the development server's window
    // connects.
    const cli = new Cli(["start", "rack.ts", "--log", "json"], app.dir, {
      NET_TOOL_TOKEN: TOKEN,
      NET_TOOL_DEV: "1",
    });
    processes.push(cli);
    const [, panel] = await cli.waitFor(
      /"device":"http-panel","message":"listening","data":\{"url":"([^"]+)"\}/,
    );
    const url = new URL("/ws", panel);
    url.protocol = "ws:";
    const ws = new WebSocket(url, {
      protocols: ["net-tool", `token.${TOKEN}`],
      headers: { origin: ORIGIN },
    });
    const messages: Payload[] = [];
    ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    expect(ws.protocol).toBe("net-tool");
    const answer = async (message: Payload) => {
      ws.send(JSON.stringify(message));
      // An answer has `ok`, and an event has `event`; both carry an `id`.
      return waitFor(() =>
        messages.find((received) => "ok" in received && received.id === message.id),
      );
    };
    const opened = await answer({
      id: 1,
      op: "open",
      input: { kind: "tcp-client", host: "127.0.0.1", port: server.port },
    });
    const socket = (opened.value as { id: number }).id;
    const hello = bytesToBase64(textToBytes("hello"));
    expect(await answer({ id: 2, op: "send", input: { id: socket, data: hello } })).toEqual({
      id: 2,
      ok: true,
      value: { sent: 5 },
    });
    const echoed = await waitFor(() =>
      messages.find((message) => message.event === "data" && message.id === socket),
    );
    expect(bytesToText(base64ToBytes(echoed.data as string))).toBe("hello");

    // examples/net-tool/README.md: editing ui and reloading keeps the window's WebSocket and the
    // TCP connection.
    // Bun's bundler drops comments, so an edit that changes the firmware adds code.
    const edit = async (path: string) =>
      app.write(path, `${await app.read(path)}\nexport const edited = ${Date.now()};\n`);
    const reload = async (device: string) => {
      const ctl = new Cli(["ctl", "reload"], app.dir);
      processes.push(ctl);
      expect(await ctl.exited()).toBe(0);
      const results = JSON.parse(ctl.stdout) as { device: string; mode: string; error?: unknown }[];
      expect(results).toEqual([expect.objectContaining({ device, mode: "hot" })]);
      expect(results[0]?.error).toBeUndefined();
    };
    await edit("devices/ui.ts");
    await reload("ui");
    const again = bytesToBase64(textToBytes("again"));
    expect(await answer({ id: 3, op: "send", input: { id: socket, data: again } })).toEqual({
      id: 3,
      ok: true,
      value: { sent: 5 },
    });
    await waitFor(() =>
      messages.some((message) => message.event === "data" && message.data === again),
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Editing net replaces it, and its sockets close with the old instance.
    await edit("devices/net.ts");
    await reload("net");
    expect(await answer({ id: 4, op: "list" })).toEqual({ id: 4, ok: true, value: [] });
    ws.close();
  });

  test("without NET_TOOL_TOKEN the rack fails to start, with RACK_INVALID_CONFIG", async () => {
    const app = await netTool();
    const cli = new Cli(["start", "rack.ts"], app.dir, { NET_TOOL_TOKEN: "" });
    processes.push(cli);
    expect(await cli.exited()).toBe(1);
    expect(cli.output).toContain("RACK_INVALID_CONFIG");
  });
});

// examples/net-tool/README.md, "Installers": the shell of a built app runs the rack compiled
// with rack compile, with its base directory, and with --watch when its setting says so.
// @decision .agents/decisions/261120_203926-net-tool-installers.md#tests
// @doc docs/guides/running.md#running-a-rack-from-another-program
describe("the net tool's rack as the sidecar of a built app", () => {
  /** The origins of a built app's window: on macOS and Linux, and on Windows. */
  const BUILT_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];
  let compiled: TempApp;
  let sidecar: string;
  const bases: string[] = [];

  beforeAll(async () => {
    compiled = await tempApp(["connectors.ts", "devices", "rack.ts"], NET_TOOL);
    const compile = new Cli(["compile", "rack.ts", "--outfile", "net-tool-rack"], compiled.dir);
    if ((await compile.exited()) !== 0) throw new Error(compile.output);
    sidecar = join(compiled.dir, WINDOWS ? "net-tool-rack.exe" : "net-tool-rack");
  }, 120_000);

  afterEach(async () => {
    // This hook runs before the file's own, so it stops the sidecars before their directories go.
    await Promise.all(processes.splice(0).map((cli) => cli.stop()));
    await Promise.all(bases.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await compiled?.remove();
  });

  /** Runs the sidecar as the shell of a built app runs it, in a base directory of its own. */
  async function start(watch: boolean): Promise<{ cli: Cli; base: string; panel: string }> {
    const base = await mkdtemp(join(tmpdir(), "racku-test-net-tool-"));
    bases.push(base);
    const command = [sidecar, "--base-dir", base, "--stop-on-stdin-close", "--log", "json"];
    const cli = new Cli(
      [],
      base,
      { NET_TOOL_TOKEN: TOKEN },
      watch ? [...command, "--watch"] : command,
    );
    processes.push(cli);
    const [, panel = ""] = await cli.waitFor(
      /"device":"http-panel","message":"listening","data":\{"url":"([^"]+)"\}/,
    );
    await cli.waitFor(/"message":"control listening"/);
    return { cli, base, panel };
  }

  /** Runs the sidecar's ctl for a base directory, and returns what it printed, parsed. */
  async function ctl<T>(base: string, op: string): Promise<T> {
    const cli = new Cli([], base, {}, [sidecar, "ctl", op, "--base-dir", base]);
    const code = await cli.exited();
    await cli.ended;
    if (code !== 0) throw new Error(`ctl ${op} exited with ${code}: ${cli.output}`);
    return JSON.parse(cli.stdout) as T;
  }

  async function ui(base: string): Promise<SlotStatus> {
    const found = (await ctl<SlotStatus[]>(base, "status")).find((slot) => slot.name === "ui");
    if (found === undefined) throw new Error("no device ui");
    return found;
  }

  /** A window's WebSocket to the panel, from `origin`, with a function that sends a command. */
  async function connect(panel: string, origin: string) {
    const url = new URL("/ws", panel);
    url.protocol = "ws:";
    const ws = new WebSocket(url, {
      protocols: ["net-tool", `token.${TOKEN}`],
      headers: { origin },
    });
    const messages: Payload[] = [];
    ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    let commands = 0;
    const answer = async (op: string, input?: unknown) => {
      const id = ++commands;
      ws.send(JSON.stringify({ id, op, input }));
      return waitFor(() => messages.find((received) => "ok" in received && received.id === id));
    };
    return { ws, messages, answer };
  }

  /** Writes the example's `connectors.ts` and `devices/ui.ts` in a base directory. */
  async function replace(base: string, files: ("connectors.ts" | "devices/ui.ts")[]) {
    for (const file of files) {
      await Bun.write(join(base, file), await Bun.file(join(NET_TOOL, file)).text());
    }
  }

  test("a window with a built app's origin opens a TCP connection, and the end of input stops the rack", async () => {
    const server = echoServer();
    const { cli, base, panel } = await start(false);
    // The development server's origin counts only in a debug build's rack.
    // @decision .agents/decisions/261122_011655-security-review-fixes.md#net-tool-and-ci
    await expect(connect(panel, ORIGIN)).rejects.toBeDefined();
    const [first = "", other = ""] = BUILT_ORIGINS;
    const { answer, messages, ws } = await connect(panel, first);
    const second = await connect(panel, other);
    expect([ws.protocol, second.ws.protocol]).toEqual(["net-tool", "net-tool"]);
    second.ws.close();
    const opened = await answer("open", {
      kind: "tcp-client",
      host: "127.0.0.1",
      port: server.port,
    });
    const socket = (opened.value as { id: number }).id;
    const hello = bytesToBase64(textToBytes("hello"));
    expect(await answer("send", { id: socket, data: hello })).toMatchObject({ ok: true });
    const echoed = await waitFor(() =>
      messages.find((message) => message.event === "data" && message.id === socket),
    );
    expect(bytesToText(base64ToBytes(echoed.data as string))).toBe("hello");
    expect((await ui(base)).packaged).toBe(true);
    ws.close();

    await cli.closeInput();
    expect(await cli.exited()).toBe(0);
    expect(cli.output).toContain("rack net-tool stopped");
  }, 60_000);

  test("without --watch, a replacement of ui waits for ctl reload, and fails without connectors.ts", async () => {
    const { base, panel } = await start(false);
    const { answer, ws } = await connect(panel, BUILT_ORIGINS[0] as string);

    await replace(base, ["devices/ui.ts"]);
    const failed = await ctl<{ device: string; error?: { code: string; message: string } }[]>(
      base,
      "reload",
    );
    expect(failed.map((result) => [result.device, result.error?.code])).toEqual([
      ["ui", "RACK_SWAP_REJECTED"],
    ]);
    expect(failed[0]?.error?.message).toContain("connectors.ts");
    expect((await ui(base)).packaged).toBe(true);
    expect(await answer("list")).toMatchObject({ ok: true, value: [] });

    await replace(base, ["connectors.ts"]);
    await Bun.sleep(1_500);
    expect((await ui(base)).packaged).toBe(true);
    const results = await ctl<{ device: string; mode: string; error?: unknown }[]>(base, "reload");
    expect(results.map((result) => [result.device, result.mode, result.error])).toEqual([
      ["ui", "hot", undefined],
    ]);
    const replaced = await ui(base);
    expect([replaced.state, replaced.packaged, replaced.source]).toEqual([
      "online",
      undefined,
      join(base, "devices", "ui.ts"),
    ]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(await answer("list")).toMatchObject({ ok: true, value: [] });
    ws.close();
  }, 60_000);

  test("with --watch, a replacement of ui applies without ctl reload, and the window stays connected", async () => {
    const { base, panel } = await start(true);
    const { answer, ws } = await connect(panel, BUILT_ORIGINS[0] as string);
    await replace(base, ["connectors.ts", "devices/ui.ts"]);
    const replaced = await waitFor(async () => {
      const slot = await ui(base);
      return slot.packaged === undefined && slot.state === "online" && slot;
    }, 15_000);
    expect(replaced.source).toBe(join(base, "devices", "ui.ts"));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(await answer("list")).toMatchObject({ ok: true, value: [] });
    ws.close();
  }, 60_000);
});

// @decision .agents/decisions/261122_011655-security-review-fixes.md#net-tool-and-ci
describe("the window's connection", () => {
  test("it reconnects while the shell says that the rack runs, and stops once the rack has stopped", async () => {
    let accepted = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, served) {
        accepted++;
        // Each WebSocket closes at once, as when the rack's panel goes away.
        return served.upgrade(request) ? undefined : new Response("no", { status: 400 });
      },
      websocket: { open: (ws) => ws.close(1001, "going away"), message() {} },
    });
    servers.push(server);
    const target = { url: server.url.href, token: TOKEN };
    let running = true;
    const states: [ConnectionState, string][] = [];
    const connection = new Connection(
      target,
      { state: (state, detail) => states.push([state, detail]), event() {} },
      async () => {
        if (running) return target;
        throw new Error("The rack stopped (exit status: 0).");
      },
    );
    try {
      await waitFor(() => accepted >= 2);
      running = false;
      await waitFor(() => states.some(([state]) => state === "stopped"));
      const before = accepted;
      await Bun.sleep(1_200);
      expect(accepted).toBe(before);
      expect(states.at(-1)).toEqual(["stopped", "The rack stopped (exit status: 0)."]);
    } finally {
      connection.close();
    }
  }, 15_000);

  test("it keeps at most 8 MiB and 10 000 messages of a socket, the newest", () => {
    const message = (size: number) => ({ bytes: new Uint8Array(size) });
    const list: { bytes: Uint8Array }[] = [];
    let held = 0;
    for (let i = 0; i < 9; i++) held = keep(list, message(1024 * 1024), held);
    expect([list.length, held]).toEqual([8, KEPT_BYTES]);
    const last = message(1);
    held = keep(list, last, held);
    expect([list.length, held, list.at(-1)]).toEqual([8, 7 * 1024 * 1024 + 1, last]);
    const small: { bytes: Uint8Array }[] = [];
    let few = 0;
    for (let i = 0; i < KEPT + 5; i++) few = keep(small, message(1), few);
    expect([small.length, few]).toEqual([KEPT, KEPT]);
  });
});

describe("the window's codec", () => {
  test("text goes to bytes as UTF-8, and bytes that aren't UTF-8 come back as U+FFFD", () => {
    expect(textToBytes("hé")).toEqual(Uint8Array.from([0x68, 0xc3, 0xa9]));
    expect(bytesToText(Uint8Array.from([0x68, 0xc3, 0xa9]))).toBe("hé");
    expect(bytesToText(Uint8Array.from([0x68, 0xff]))).toBe("h�");
  });

  test("hex is pairs of digits, with optional spaces between pairs", () => {
    expect(hexToBytes("68 65 6c6C 6f")).toEqual(textToBytes("hello"));
    expect(hexToBytes("  ")).toEqual(new Uint8Array());
    expect(bytesToHex(textToBytes("hello"))).toBe("68 65 6c 6c 6f");
    expect(() => hexToBytes("6g")).toThrow(HexError);
    expect(() => hexToBytes("686")).toThrow(HexError);
    expect(() => hexToBytes("6 8")).toThrow(HexError);
  });

  test("base64 carries any bytes", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(textToBytes("hello"))).toBe("aGVsbG8=");
  });
});
