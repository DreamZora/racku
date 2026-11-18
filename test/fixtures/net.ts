/**
 * Network clients for the listener and panel tests: raw HTTP requests, WebSockets that read or
 * stop reading, and the certificate a TLS server presents.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#tests
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { waitFor } from "./app.ts";

/** A free port, which a test then asks a listener for. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);
  return port as number;
}

/** A WebSocket client with the messages it got and the code it closed with. */
export interface TestSocket {
  ws: WebSocket;
  messages: string[];
  closed: Promise<number>;
}

/**
 * Opens a WebSocket to `path` on `url` and waits for its first message.
 *
 * @param protocols Subprotocols the client offers.
 */
export async function socketTo(
  url: URL | string,
  path = "/ws",
  protocols?: string[],
): Promise<TestSocket> {
  const target = new URL(path, url);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(target.href, {
    ...(protocols === undefined ? {} : { protocols }),
    tls: { rejectUnauthorized: false },
  } as never);
  ws.binaryType = "arraybuffer";
  const messages: string[] = [];
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  ws.addEventListener("message", (e) => {
    messages.push(
      typeof e.data === "string" ? e.data : `${(e.data as ArrayBuffer).byteLength} bytes`,
    );
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  await waitFor(() => messages.length > 0);
  return { ws, messages, closed };
}

/** The lines of a WebSocket upgrade request, after the request line and `Host`. */
export const UPGRADE_HEADERS = [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
];

/** Sends raw request lines on a new connection and returns the response's status line. */
export function rawStatus(port: number, lines: string[], body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);
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
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("no answer"));
    });
  });
}

/** Sends raw request lines on a new connection and returns the head of the response. */
export function rawHead(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      const end = data.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.destroy();
        resolve(data.slice(0, end));
      }
    });
    socket.on("error", reject);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("no answer"));
    });
  });
}

/**
 * A text frame as a client sends it: masked, as RFC 6455 requires, and shorter than 126 bytes.
 */
export function clientFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const mask = [1, 2, 3, 4];
  const frame = new Uint8Array(6 + payload.length);
  frame.set([0x81, 0x80 | payload.length, ...mask]);
  for (const [i, byte] of payload.entries()) frame[6 + i] = byte ^ (mask[i % 4] as number);
  return frame;
}

/**
 * Opens a WebSocket over a raw connection, sends `first` as a text frame, and then reads
 * nothing more, so that what the server sends piles up.
 */
export function stalledSocket(port: number, path: string, first?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `${[`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, ...UPGRADE_HEADERS].join("\r\n")}\r\n\r\n`,
      );
    });
    socket.once("data", () => {
      if (first !== undefined) socket.write(clientFrame(first));
      socket.pause();
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

/** The common name of the certificate a TLS server presents for a server name. */
export function certificateOf(port: number, servername?: string): Promise<string> {
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
