/**
 * The device of the listener tests, which serves HTTP and WebSocket on listeners of its own.
 * `devices/listener.ts` mounts it without a state handover, `devices/listener-state.ts` with one.
 *
 * A test steers the next instance through `RACK42U_TEST_LISTENER` in the environment, which a
 * Worker copies when it starts: JSON with `fail`, the hook the instance fails, `activateMs`, how
 * long its `activate` takes, and `jam`, a pipe that `/jam` blocks the thread on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  device,
  type Listener,
  type ListenerHandlers,
  type ListenerTls,
  type NoPorts,
  RackError,
  type ServeOptions,
} from "rack42u";
import * as v from "valibot";
import { ListenerControl, PairPaths } from "./connectors.ts";

const Address = v.object({ port: v.number(), hostname: v.optional(v.string()) });

/** The configuration of the device. */
export const ListenerConfig = v.optional(
  v.object({
    port: v.optional(v.number(), 0),
    hostname: v.optional(v.string()),
    label: v.optional(v.string(), "v1"),
    tls: v.optional(v.union([PairPaths, v.array(PairPaths)])),
    allowedHosts: v.optional(v.array(v.string())),
    maxRequestBodySize: v.optional(v.number()),
    idleTimeout: v.optional(v.number()),
    maxPayloadLength: v.optional(v.number()),
    maxBuffered: v.optional(v.number()),
    /** How long the state handover's snapshot takes, in ms. */
    snapshotMs: v.optional(v.number(), 0),
    /** Catches a rejection of the first serve() and powers on all the same. */
    catchServe: v.optional(v.boolean(), false),
    /** Calls serve() once more from activate, which must fail. */
    lateServe: v.optional(v.boolean(), false),
    /** More listeners, after the first. */
    more: v.optional(v.array(Address), []),
  }),
  {},
);

type Config = v.InferOutput<typeof ListenerConfig>;
type Data = { id: number };

const steer = JSON.parse(process.env.RACK42U_TEST_LISTENER ?? "{}") as {
  fail?: string;
  activateMs?: number;
  jam?: string;
};
/** Which instance this is: every instance of the device has its own. */
const instance = Math.random().toString(36).slice(2, 8);
let label = "v1";
let served = 0;
const closes: number[] = [];
const sockets = new Map<number, Bun.ServerWebSocket<Data>>();
let nextSocket = 1;
let first: Listener<Data> | undefined;
let lateServe: string | undefined;

function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy on purpose: the event loop gets no turn.
  }
}

function fail(hook: string): void {
  if (steer.fail === hook) throw new RackError("TEST_FAILED", `${hook} failed on purpose`);
}

function tlsOf(
  config: Pick<Config, "tls">,
  baseDir: string,
): ListenerTls | ListenerTls[] | undefined {
  const pair = (p: v.InferOutput<typeof PairPaths>): ListenerTls => ({
    cert: Bun.file(join(baseDir, p.cert)),
    key: Bun.file(join(baseDir, p.key)),
    ...(p.serverName === undefined ? {} : { serverName: p.serverName }),
  });
  if (config.tls === undefined) return undefined;
  return Array.isArray(config.tls) ? config.tls.map(pair) : pair(config.tls);
}

function handlers(): ListenerHandlers<Data> {
  return {
    async fetch(request, listener) {
      const url = new URL(request.url);
      served++;
      switch (url.pathname) {
        case "/who":
          return new Response(`${label}:${instance} ${served}`);
        case "/slow":
          await Bun.sleep(Number(url.searchParams.get("ms") ?? 300));
          return new Response(`${label}:${instance} slow`);
        case "/long":
          // Lifts Bun's timer for this request, which would cut an exchange this long.
          listener.timeout(request, 0);
          await Bun.sleep(Number(url.searchParams.get("ms") ?? 300));
          return new Response(`${label}:${instance} long`);
        case "/ip":
          return new Response(listener.requestIP(request)?.address ?? "none");
        case "/throw":
          throw new Error("thrown on purpose");
        case "/stream": {
          const n = Number(url.searchParams.get("n") ?? 5);
          const gap = Number(url.searchParams.get("gap") ?? 50);
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (sent > 0) await Bun.sleep(gap);
              if (sent === n) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode(`${label}:${instance} ${sent++}\n`));
            },
          });
          return new Response(body);
        }
        case "/body":
          return new Response(String((await request.arrayBuffer()).byteLength));
        case "/ws": {
          const id = nextSocket++;
          if (listener.upgrade(request, { data: { id } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        case "/block":
          spin(Number(url.searchParams.get("ms") ?? 3_000));
          return new Response("blocked");
        case "/jam":
          // Blocks the thread in a system call until the test releases the pipe.
          if (steer.jam !== undefined) readFileSync(steer.jam);
          return new Response("jammed");
        case "/crash":
          setTimeout(() => process.exit(3), 10);
          return new Response("crashing");
        default:
          return new Response("not found", { status: 404 });
      }
    },
    routes: {
      "/route/:name": (request) => new Response(`${label} route ${request.params.name}`),
      "/static": new Response("static"),
      "/methods": { POST: () => new Response(`${label} post`) },
    },
    error: (error) => new Response(`handled: ${error.message}`, { status: 500 }),
    websocket: {
      open(ws) {
        sockets.set(ws.data.id, ws);
        ws.subscribe("news");
        ws.send(`${label}:${instance} open ${ws.data.id}`);
      },
      async message(ws, message) {
        const text = typeof message === "string" ? message : `${message.byteLength} bytes`;
        if (text === "slow") {
          await Bun.sleep(400);
          ws.send(`${label}:${instance} slow done`);
          return;
        }
        ws.send(`${label}:${instance} ${text}`);
      },
      close(ws, code) {
        sockets.delete(ws.data.id);
        closes.push(code);
      },
    },
  };
}

/** The device, with or without a state handover, replaced by hot or cold swaps. */
export function listenerDevice(model: string, handover: boolean, swap: "hot" | "cold" = "hot") {
  return device<NoPorts, { control: typeof ListenerControl }, typeof ListenerConfig>({
    model,
    swap,
    config: ListenerConfig,
    provides: { control: ListenerControl },
    async powerOn(ctx) {
      label = ctx.config.label;
      const options = (address: { port: number; hostname?: string | undefined }) => {
        const serve: ServeOptions<Data> = { ...handlers(), port: address.port };
        if (address.hostname !== undefined) serve.hostname = address.hostname;
        const { allowedHosts, maxRequestBodySize, idleTimeout, maxPayloadLength, maxBuffered } =
          ctx.config;
        if (allowedHosts !== undefined) serve.allowedHosts = allowedHosts;
        if (maxRequestBodySize !== undefined) serve.maxRequestBodySize = maxRequestBodySize;
        if (idleTimeout !== undefined) serve.idleTimeout = idleTimeout;
        serve.websocket = {
          ...serve.websocket,
          ...(maxPayloadLength === undefined ? {} : { maxPayloadLength }),
          ...(maxBuffered === undefined ? {} : { maxBuffered }),
        };
        return serve;
      };
      const main = options(ctx.config);
      const tls = tlsOf(ctx.config, ctx.baseDir);
      if (tls !== undefined) main.tls = tls;
      if (ctx.config.catchServe) {
        try {
          first = await ctx.serve(main);
        } catch {
          // On purpose: the device powers on without its listener, which the rack refuses.
        }
      } else first = await ctx.serve(main);
      for (const address of ctx.config.more) await ctx.serve(options(address));
      fail("powerOn");
      return {
        control: {
          url: () => first?.url.href ?? "",
          async setTls(paths) {
            const tls = tlsOf({ tls: paths }, ctx.baseDir);
            if (tls !== undefined) await first?.setTls(tls);
          },
          publish: ({ topic, data }) => first?.publish(topic, data) ?? 0,
          reload(next) {
            label = next;
            first?.reload(handlers());
          },
          async flood({ id, size, count }) {
            const ws = sockets.get(id);
            let sent = 0;
            const chunk = new Uint8Array(size);
            for (let i = 0; i < count && ws !== undefined; i++) {
              if (ws.send(chunk) === 0) break;
              sent++;
              if (i % 16 === 0) await Bun.sleep(1);
            }
            return { sent, closed: !sockets.has(id) };
          },
          state: () => ({
            label: lateServe === undefined ? label : `${label} ${lateServe}`,
            served,
            closes: [...closes],
          }),
        },
      };
    },
    selfTest() {
      fail("selfTest");
    },
    async activate(ctx) {
      if (steer.activateMs) await Bun.sleep(steer.activateMs);
      fail("activate");
      if (ctx.config.lateServe) {
        await ctx.serve({ port: 0, fetch: () => new Response("late") }).then(
          () => {
            lateServe = "served late";
          },
          (error: unknown) => {
            lateServe = error instanceof RackError ? error.code : String(error);
          },
        );
      }
    },
    ...(handover
      ? {
          async snapshot(ctx) {
            ctx.log.info("hook", { hook: "snapshot" });
            if (ctx.config.snapshotMs > 0) await Bun.sleep(ctx.config.snapshotMs);
            return { served };
          },
          restore(_ctx, state) {
            fail("restore");
            const parsed = v.safeParse(v.object({ served: v.number() }), state);
            if (parsed.success) served = parsed.output.served;
          },
        }
      : {}),
  });
}
