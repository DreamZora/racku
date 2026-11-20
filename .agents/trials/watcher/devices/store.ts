import { device } from "rack42u";
import * as v from "valibot";
import { Result, Watch } from "../connectors.ts";

type Status = { url: string; at: number; result: Result };
type Report = { url: string; at: number; from: Result; to: Result };

const MAX_EVENTS = 100;

// Each instance runs in a Worker of its own, so module state is the instance's.
let status = new Map<string, Status>();
let events: Report[] = [];

export default device({
  model: "store",
  provides: { watch: Watch },
  config: v.object({ port: v.number() }),

  async powerOn(ctx) {
    await ctx.serve({
      port: ctx.config.port,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
        if (path === "/events") return Response.json(events);
        if (path === "/status") return Response.json([...status.values()]);
        return new Response("not found", { status: 404 });
      },
    });

    return {
      watch: {
        record({ url, at, result, from }) {
          status.set(url, { url, at, result });
          if (from) {
            events.unshift({ url, at, from, to: result });
            if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
          }
        },
        last: (url) => status.get(url)?.result ?? null,
        forget(url) {
          status.delete(url);
        },
      },
    };
  },

  snapshot: () => ({ status: [...status.values()], events }),
  restore(_ctx, state) {
    const parsed = v.safeParse(
      v.object({ status: v.array(v.any()), events: v.array(v.any()) }),
      state,
    );
    if (!parsed.success) return;
    status = new Map((parsed.output.status as Status[]).map((s) => [s.url, s]));
    events = parsed.output.events as Report[];
  },
});
