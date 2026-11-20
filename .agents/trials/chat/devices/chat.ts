import { device } from "rack42u";
import { Http, httpHandler, type HttpHandler } from "rack42u/std";
import * as v from "valibot";
import { History } from "../connectors.ts";

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TEXT = 1000;
const RECENT = 20;

type Member = { room: string; user: string };

let handler: HttpHandler<Member> | undefined;

export default device({
  model: "chat",
  needs: { history: History },
  provides: { http: Http },

  powerOn(ctx) {
    const send = (ws: { send(data: string): unknown }, value: unknown) => ws.send(JSON.stringify(value));

    const own: HttpHandler<Member> = httpHandler<Member>(
      {
        fetch(request, server) {
          const url = new URL(request.url);
          if (url.pathname === "/rooms" && request.method === "GET") {
            const counts = new Map<string, number>();
            for (const { data } of own.list()) counts.set(data.room, (counts.get(data.room) ?? 0) + 1);
            return Response.json([...counts].map(([room, users]) => ({ room, users })));
          }
          if (url.pathname !== "/chat") return new Response("not found", { status: 404 });
          const room = url.searchParams.get("room") ?? "";
          const user = url.searchParams.get("user") ?? "";
          if (!NAME.test(room) || !NAME.test(user)) return new Response("bad room or user", { status: 400 });
          if (server.upgrade(request, { data: { room, user } })) return;
          return new Response("this needs a WebSocket", { status: 426 });
        },
        websocket: {
          async open(ws) {
            const recent = await ctx.ports.history.recent({ room: ws.data.room, limit: RECENT });
            for (const message of recent) send(ws, message);
          },
          async message(ws, data) {
            if (typeof data !== "string" || data.length > MAX_TEXT) {
              send(ws, { error: "message too long" });
              return;
            }
            const message = { room: ws.data.room, user: ws.data.user, text: data, at: Date.now() };
            await ctx.ports.history.add(message);
            const members = own.list().filter((member) => member.data.room === message.room);
            if (members.length === 0) return;
            return ctx.emit.http.send({ socket: members.map((member) => member.socket), data: JSON.stringify(message) });
          },
        },
      },
      ctx.emit.http,
    );
    handler = own;
    return { http: own };
  },

  // The sockets belong to the HTTP panel, and the new instance must know them to keep serving them.
  snapshot: () => ({ sockets: handler?.list() ?? [] }),
  restore(_ctx, snapshot) {
    const parsed = v.safeParse(
      v.object({
        sockets: v.array(v.object({ socket: v.string(), data: v.object({ room: v.string(), user: v.string() }) })),
      }),
      snapshot,
    );
    if (parsed.success) handler?.restore(parsed.output.sockets);
  },
});
