/**
 * The net tool's window protocol: each window holds one WebSocket through the HTTP panel. Its
 * commands mirror `net/v1`'s RPCs, and `ui` answers each one, and passes `net/v1`'s events to
 * every window. The sockets survive a hot swap of `ui`.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-windows-protocol
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { device, isRackError } from "racku";
import { Http, type HttpHandler, httpHandler } from "racku/std";
import * as v from "valibot";
import { Address, Net } from "../connectors.ts";

/** The subprotocol of the window's WebSocket. */
const PROTOCOL = "net-tool";

const Port = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65_535));

/** A command from a window: `op` names a `net/v1` RPC, and `input` is its input. */
const Command = v.variant("op", [
  v.object({
    id: v.number(),
    op: v.literal("open"),
    input: v.object({
      kind: v.picklist(["tcp-client", "tcp-server", "udp"]),
      host: v.string(),
      port: Port,
    }),
  }),
  v.object({
    id: v.number(),
    op: v.literal("send"),
    // The bytes travel as base64 in the window's JSON.
    input: v.object({ id: v.number(), data: v.string(), to: v.optional(Address) }),
  }),
  v.object({ id: v.number(), op: v.literal("close"), input: v.object({ id: v.number() }) }),
  v.object({ id: v.number(), op: v.literal("list"), input: v.optional(v.undefined()) }),
]);
type Command = v.InferOutput<typeof Command>;

/** What `ui` carries across a hot swap: its windows, and the events it passed per socket. */
const State = v.object({
  sockets: v.array(v.object({ socket: v.string(), data: v.unknown() })),
  delivered: v.array(v.tuple([v.number(), v.number()])),
});

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Compares a token in constant time, whatever its length. */
function sameToken(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The windows' sockets, which `snapshot` and `restore` carry to the next instance. */
let handler: HttpHandler | undefined;
/** The `data` events passed on, by socket, which the window compares with `net`'s count. */
const delivered = new Map<number, number>();

export default device({
  model: "ui",
  needs: { net: Net },
  provides: { http: Http },
  config: v.object({
    token: v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{32,}$/i, "the token needs at least 32 hex digits"),
    ),
    origins: v.array(v.string()),
  }),

  powerOn(ctx) {
    const http = httpHandler(
      {
        fetch(request, server) {
          if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("Not Found", { status: 404 });
          }
          const offered = (request.headers.get("sec-websocket-protocol") ?? "")
            .split(",")
            .map((protocol) => protocol.trim());
          const token = offered.find((protocol) => protocol.startsWith("token."))?.slice(6);
          const origin = request.headers.get("origin");
          const allowed =
            origin !== null &&
            ctx.config.origins.includes(origin) &&
            offered.includes(PROTOCOL) &&
            token !== undefined &&
            sameToken(token, ctx.config.token);
          if (!allowed) return new Response("Forbidden", { status: 403 });
          if (server.upgrade(request, { protocol: PROTOCOL, data: {} })) return;
          return new Response("Bad Request", { status: 400 });
        },
        websocket: {
          async message(ws, data) {
            ws.send(JSON.stringify(await answer(data)));
          },
        },
      },
      ctx.emit.http,
    );
    handler = http;

    /** Runs one command from a window, and returns the answer to send back. */
    const answer = async (data: string | Uint8Array) => {
      let command: Command;
      try {
        if (typeof data !== "string") throw new Error("a command is JSON text");
        const parsed = v.safeParse(Command, JSON.parse(data));
        if (!parsed.success) throw new Error(v.summarize(parsed.issues));
        command = parsed.output;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id: null, ok: false, error: { code: "RACK_INVALID_INPUT", message } };
      }
      try {
        return { id: command.id, ok: true, value: await run(command) };
      } catch (error) {
        const failure = isRackError(error)
          ? { code: error.code, message: error.message }
          : { code: "RACK_DEVICE_FAULT", message: String(error) };
        return { id: command.id, ok: false, error: failure };
      }
    };

    const run = async (command: Command) => {
      const net = ctx.ports.net;
      switch (command.op) {
        case "open":
          return net.open(command.input);
        case "send": {
          const { id, data, to } = command.input;
          const bytes = new Uint8Array(Buffer.from(data, "base64"));
          return net.send(to === undefined ? { id, data: bytes } : { id, data: bytes, to });
        }
        case "close":
          return net.close(command.input);
        case "list":
          return (await net.list(undefined)).map((socket) => ({
            ...socket,
            delivered: delivered.get(socket.id) ?? 0,
          }));
      }
    };

    /** Sends an event to every window. */
    const broadcast = (message: Record<string, unknown>) => {
      const sockets = http.list().map((window) => window.socket);
      if (sockets.length === 0) return;
      ctx.emit.http.send({ socket: sockets, data: JSON.stringify(message) }).catch((error) => {
        ctx.log.warn("event not passed to the windows", { error: String(error) });
      });
    };
    ctx.on.net.opened((payload) => broadcast({ event: "opened", ...payload }));
    ctx.on.net.data(({ id, data, from }) => {
      delivered.set(id, (delivered.get(id) ?? 0) + 1);
      broadcast({ event: "data", id, data: base64(data), ...(from === undefined ? {} : { from }) });
    });
    ctx.on.net.closed((payload) => {
      delivered.delete(payload.id);
      broadcast({ event: "closed", ...payload });
    });

    return { http };
  },

  snapshot: () => ({ sockets: handler?.list() ?? [], delivered: [...delivered] }),

  restore(_ctx, state) {
    const parsed = v.safeParse(State, state);
    if (!parsed.success) return;
    handler?.restore(parsed.output.sockets);
    for (const [id, count] of parsed.output.delivered) delivered.set(id, count);
  },
});
