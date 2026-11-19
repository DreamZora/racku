/**
 * The window's connection to the rack: one WebSocket to the `ui` device, through the HTTP panel.
 * It reconnects with a backoff from 0.5 s to 5 s, and matches each answer to its command.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-windows-protocol
 */
import { invoke } from "@tauri-apps/api/core";

/** How long a command waits for its answer, a little longer than the rack's call timeout. */
const ANSWER_TIMEOUT = 35_000;

export interface Address {
  host: string;
  port: number;
}

/** Where the rack's panel listens, and the token that its `ui` device wants. */
export interface Endpoint {
  url: string;
  token: string;
}

/** A socket as `list` reports it, with the `data` events `ui` passed on for it. */
export interface SocketInfo {
  id: number;
  kind: "tcp-client" | "tcp-server" | "tcp-connection" | "udp";
  server?: number;
  local: Address;
  remote?: Address;
  sent: number;
  received: number;
  events: number;
  delivered: number;
}

/** An event of `net/v1`, with its bytes as base64. */
export type NetEvent =
  | { event: "opened"; id: number; server?: number; local: Address; remote: Address }
  | { event: "data"; id: number; data: string; from?: Address }
  | { event: "closed"; id: number; error?: string };

type Answer =
  | { id: number; ok: true; value: unknown }
  | { id: number | null; ok: false; error: { code: string; message: string } };

export type ConnectionState = "connecting" | "open" | "closed";

/** A command that failed, with the error code the rack gave. */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Where the rack listens: from the Tauri shell, or, in a browser during development, from the
 * page's `?url=` and `&token=`.
 */
export async function endpoint(): Promise<Endpoint> {
  if ("__TAURI_INTERNALS__" in window) return invoke<Endpoint>("endpoint");
  const params = new URLSearchParams(location.search);
  const url = params.get("url");
  const token = params.get("token");
  if (import.meta.env.DEV && url !== null && token !== null) return { url, token };
  throw new Error("no rack to connect to; start the tool with `bun run tauri dev`");
}

export class Connection {
  #ws: WebSocket | undefined;
  #commands = 0;
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  #delay = 500;
  #stopped = false;

  constructor(
    readonly target: Endpoint,
    readonly on: {
      state(state: ConnectionState, detail: string): void;
      event(event: NetEvent): void;
    },
  ) {
    this.#connect();
  }

  #connect(): void {
    this.on.state("connecting", this.target.url);
    const url = new URL("/ws", this.target.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, ["net-tool", `token.${this.target.token}`]);
    this.#ws = ws;
    ws.addEventListener("open", () => {
      this.#delay = 500;
      this.on.state("open", this.target.url);
    });
    ws.addEventListener("message", (message) => this.#receive(String(message.data)));
    ws.addEventListener("close", (closed) => {
      this.#fail(new CommandError("RACK_LINK_DOWN", "the connection to the rack closed"));
      if (this.#stopped) return;
      const seconds = this.#delay / 1000;
      this.on.state("closed", `closed with ${closed.code}; connecting again in ${seconds} s`);
      setTimeout(() => this.#connect(), this.#delay);
      this.#delay = Math.min(this.#delay * 2, 5_000);
    });
  }

  #receive(text: string): void {
    const message = JSON.parse(text) as Answer | NetEvent;
    if ("event" in message) {
      this.on.event(message);
      return;
    }
    const waiting = message.id === null ? undefined : this.#pending.get(message.id);
    if (waiting === undefined || message.id === null) return;
    this.#pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(new CommandError(message.error.code, message.error.message));
  }

  #fail(error: Error): void {
    for (const waiting of this.#pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.#pending.clear();
  }

  /** Sends a command, `op` with `input`, and resolves with the value of its answer. */
  command<T>(op: "open" | "send" | "close" | "list", input?: unknown): Promise<T> {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CommandError("RACK_LINK_DOWN", "not connected to the rack"));
    }
    const id = ++this.#commands;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CommandError("RACK_TIMEOUT", `no answer to ${op} within ${ANSWER_TIMEOUT / 1000} s`));
      }, ANSWER_TIMEOUT);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      ws.send(JSON.stringify({ id, op, input }));
    });
  }

  /** Closes the WebSocket for good. */
  close(): void {
    this.#stopped = true;
    this.#ws?.close();
  }
}
