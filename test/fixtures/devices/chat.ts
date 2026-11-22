import { device, RackError } from "racku";
import { Http, type HttpHandler, httpHandler } from "racku/std";
import * as v from "valibot";

type Data = { name: string };

/** Which instance this is: every instance of the device has its own. */
const instance = Math.random().toString(36).slice(2, 8);
/** The close codes its sockets got, by socket. */
const closes: { socket: string; code: number }[] = [];
/** The numbers of the `seq` messages, in the order their calls started. */
const starts: number[] = [];
let active = 0;
let maxActive = 0;
let handler: HttpHandler<Data> | undefined;

const State = v.object({
  sockets: v.array(v.object({ socket: v.string(), data: v.object({ name: v.string() }) })),
});

/** Serves WebSockets through the HTTP panel, and hands them over in a swap. */
export default device({
  model: "chat",
  provides: { http: Http },
  powerOn(ctx) {
    handler = httpHandler<Data>(
      {
        async fetch(request, server) {
          const url = new URL(request.url);
          switch (url.pathname) {
            case "/chat": {
              if (url.searchParams.has("refuse")) return new Response("go away", { status: 403 });
              // Answers the upgrade this long after it came, as a slow device would.
              const delay = url.searchParams.get("delay");
              if (delay !== null) await Bun.sleep(Number(delay));
              const protocol = url.searchParams.get("protocol");
              const data = { name: url.searchParams.get("name") ?? "anon" };
              const headers = { "x-chat": "welcome" };
              const accepted = server.upgrade(
                request,
                protocol === null ? { data, headers } : { data, headers, protocol },
              );
              return accepted ? undefined : new Response("not an upgrade", { status: 400 });
            }
            case "/chat/state":
              return Response.json({
                instance,
                sockets: handler?.list().map((s) => s.socket) ?? [],
                closes,
                starts,
                maxActive,
              });
            case "/chat/crash":
              setTimeout(() => process.exit(3), 10);
              return new Response("crashing");
          }
          return new Response("no such page", { status: 404 });
        },
        websocket: {
          open(ws) {
            if (ws.data.name === "fail-open") throw new RackError("CHAT_FAILED", "no entry");
            ws.send(`welcome ${ws.data.name} ${instance} ${ws.id}`);
          },
          async message(ws, data) {
            if (typeof data !== "string") {
              // Binary goes back as it arrived, through the port's send event, which takes the
              // type that a message arrives with (#14).
              await ctx.emit.http.send({ socket: ws.id, data });
              return;
            }
            if (data === "fail") throw new RackError("CHAT_FAILED", "failed on purpose");
            if (data === "busy") throw new RackError("RACK_OVERLOADED", "too busy");
            if (data === "bye") {
              ws.close(4000, "bye");
              return;
            }
            if (data.startsWith("seq ")) {
              active++;
              maxActive = Math.max(maxActive, active);
              starts.push(Number(data.slice(4)));
              await Bun.sleep(20);
              active--;
              return;
            }
            if (data.startsWith("all ")) {
              const sockets = handler?.list().map((s) => s.socket) ?? [];
              await ctx.emit.http.send({ socket: sockets, data: data.slice(4) });
              return;
            }
            if (data.startsWith("to ")) {
              // Sends to any socket id, also one that closed.
              const [, socket, ...words] = data.split(" ");
              await ctx.emit.http.send({ socket: socket as string, data: words.join(" ") });
              return;
            }
            if (data.startsWith("flood ")) {
              const chunk = new Uint8Array(64 * 1024);
              for (let i = 0; i < Number(data.slice(6)); i++) ws.send(chunk);
              return;
            }
            ws.send(`${instance} ${ws.data.name}: ${data}`);
          },
          close(ws, code) {
            closes.push({ socket: ws.id, code });
          },
        },
      },
      ctx.emit.http,
    );
    return { http: handler };
  },
  snapshot: () => ({ sockets: handler?.list() ?? [] }),
  restore(_ctx, state) {
    const parsed = v.safeParse(State, state);
    if (parsed.success) handler?.restore(parsed.output.sockets);
  },
});
