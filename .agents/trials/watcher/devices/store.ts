import { device } from "rack42u";
import { Http, httpHandler } from "rack42u/std";
import * as v from "valibot";
import { Observation, Reports, Result } from "../connectors.ts";

const LIMIT = 100;

type Report = { url: string; at: string; from: Result; to: Result };
type Status = { url: string; at: string; result: Result };

const State = v.object({
  events: v.array(v.object({ url: v.string(), at: v.string(), from: Result, to: Result })),
  status: v.array(v.object({ url: v.string(), at: v.string(), result: Result })),
});

// In-memory state of this Worker; it reaches a new instance through snapshot and restore.
let events: Report[] = []; // newest first
let status = new Map<string, Status>();

/** Keeps the reports of every checker, and serves them. */
export default device({
  model: "store",
  provides: { reports: Reports, http: Http },

  powerOn(ctx) {
    const handler = httpHandler((request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (path === "/events") return Response.json(events);
      if (path === "/status") return Response.json([...status.values()]);
      return new Response("not found", { status: 404 });
    });

    return {
      reports: {
        record(o: Observation) {
          status.set(o.url, { url: o.url, at: o.at, result: o.result });
          if (o.change) {
            events.unshift({ url: o.url, at: o.at, from: o.change.from, to: o.change.to });
            if (events.length > LIMIT) events.length = LIMIT;
            ctx.log.info("changed", { url: o.url });
          }
        },
        last: (url: string) => status.get(url)?.result ?? null,
      },
      http: handler,
    };
  },

  snapshot: () => ({ events, status: [...status.values()] }),
  restore(_ctx, state) {
    const parsed = v.safeParse(State, state);
    if (!parsed.success) return;
    events = parsed.output.events;
    status = new Map(parsed.output.status.map((s) => [s.url, s]));
  },
});
