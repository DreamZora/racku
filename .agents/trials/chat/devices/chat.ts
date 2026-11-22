import { device } from "racku";
import { Http, httpHandler, type HttpHandler } from "racku/std";
import * as v from "valibot";
import { History } from "../connectors.ts";

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TEXT = 1000;

type Member = { room: string; user: string };

const Members = v.array(
  v.object({ socket: v.string(), data: v.object({ room: v.string(), user: v.string() }) }),
);

// Module scope belongs to one instance; snapshot and restore hand it over.
let handler: HttpHandler<Member> | undefined;

export default device({
  model: "chat",
  needs: { history: History },
  provides: { http: Http },

  powerOn(ctx) {
    const h: HttpHandler<Member> = httpHandler(
      {
        async fetch(request, server) {
          const url = new URL(request.url);
          if (url.pathname === "/rooms") {
            const counts = new Map<string, Set<string>>();
            for (const { data } of h.list()) {
              const users = counts.get(data.room) ?? new Set<string>();
              users.add(data.user);
              counts.set(data.room, users);
            }
            return Response.json(
              [...counts]
                .map(([room, users]) => ({ room, users: users.size }))
                .sort((a, b) => a.room.localeCompare(b.room)),
            );
          }
          const room = url.searchParams.get("room") ?? "";
          const user = url.searchParams.get("user") ?? "";
          if (!NAME.test(room) || !NAME.test(user)) {
            return new Response("room and user are 1 to 32 letters, digits, - or _", { status: 400 });
          }
          // Browsers apply no CORS to WebSockets: accept only the page's own origin.
          const origin = request.headers.get("origin");
          if (origin !== null && new URL(origin).host !== request.headers.get("host")) {
            return new Response("forbidden", { status: 403 });
          }
          if (server.upgrade(request, { data: { room, user } })) return;
          return new Response("this endpoint needs a WebSocket", { status: 426 });
        },
        websocket: {
          async open(ws) {
            const recent = await ctx.ports.history.recent({ room: ws.data.room });
            for (const message of recent) ws.send(JSON.stringify(message));
          },
          async message(ws, data) {
            if (typeof data !== "string") {
              ws.send(JSON.stringify({ error: "text only" }));
              return;
            }
            if (data.length > MAX_TEXT) {
              ws.send(JSON.stringify({ error: "message too long" }));
              return;
            }
            const message = { room: ws.data.room, user: ws.data.user, text: data, at: Date.now() };
            await ctx.ports.history.add(message);
            const members = h.list().filter((member) => member.data.room === ws.data.room);
            await ctx.emit.http.send({
              socket: members.map((member) => member.socket),
              data: JSON.stringify(message),
            });
          },
        },
      },
      ctx.emit.http,
    );
    handler = h;
    return { http: h };
  },

  snapshot: () => handler?.list() ?? [],
  restore(_ctx, state) {
    const parsed = v.safeParse(Members, state);
    if (parsed.success) handler?.restore(parsed.output);
  },
});
