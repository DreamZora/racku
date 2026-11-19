import { httpHandler } from "rack42u/std";

type Data = { room: string; user: string };
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_LENGTH = 1000;

type Ctx = {
  ports: { history: { add(m: any): Promise<unknown>; recent(room: string): Promise<any[]> } };
  emit: { http: { send(p: { socket: string | string[]; data: string }): Promise<unknown> } };
};

/** The handling of messages, shared by the versions of the chat device. */
export function chatHandler(ctx: Ctx, transform: (text: string) => string = (t) => t) {
  const handler = httpHandler<Data>(
    {
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/rooms") {
          const counts = new Map<string, number>();
          for (const { data } of handler.list()) counts.set(data.room, (counts.get(data.room) ?? 0) + 1);
          return Response.json([...counts].map(([room, users]) => ({ room, users })));
        }
        const room = url.searchParams.get("room") ?? "";
        const user = url.searchParams.get("user") ?? "";
        if (!NAME.test(room) || !NAME.test(user)) {
          return new Response("invalid room or user", { status: 400 });
        }
        if (server.upgrade(request, { data: { room, user } })) return;
        return new Response("expected a WebSocket", { status: 426 });
      },
      websocket: {
        async open(ws) {
          for (const message of await ctx.ports.history.recent(ws.data.room)) {
            ws.send(JSON.stringify(message));
          }
        },
        async message(ws, data) {
          if (typeof data !== "string") return;
          if (data.length > MAX_LENGTH) {
            ws.send(JSON.stringify({ error: "message too long" }));
            return;
          }
          const message = { room: ws.data.room, user: ws.data.user, text: transform(data), at: Date.now() };
          await ctx.ports.history.add(message);
          const socket = handler
            .list()
            .filter((s) => s.data.room === message.room)
            .map((s) => s.socket);
          await ctx.emit.http.send({ socket, data: JSON.stringify(message) });
        },
      },
    },
    ctx.emit.http as never,
  );
  return handler;
}
