import { device } from "racku";
import { Http, httpHandler } from "racku/std";
import { Reports, type Report, type Result } from "../connectors.ts";

const last = new Map<string, { at: string; result: Result }>();
let events: Report[] = [];

const same = (a: Result, b: Result) =>
  a.status === b.status && a.hash === b.hash && a.error === b.error;
const failed = (r: Result) => r.error !== undefined || (r.status ?? 0) >= 400;

/** Observations come in; the first one of a URL is a report only when it failed. */
export function observe(url: string, at: string, result: Result): boolean {
  const before = last.get(url);
  last.set(url, { at, result });
  const changed = before ? !same(before.result, result) : failed(result);
  if (changed) {
    events = [{ url, at, from: before?.result ?? null, to: result }, ...events].slice(0, 100);
  }
  return changed;
}

export default device({
  model: "store",
  provides: { reports: Reports, http: Http },

  powerOn() {
    return {
      reports: { observe: ({ url, at, result }) => observe(url, at, result) },
      http: httpHandler((request) => {
        const path = new URL(request.url).pathname;
        if (path === "/events") return Response.json(events);
        if (path === "/status") {
          return Response.json(
            [...last].map(([url, { at, result }]) => ({ url, at, ...result })),
          );
        }
        return new Response("not found", { status: 404 });
      }),
    };
  },

  snapshot: () => ({ last: [...last], events }),
  restore(_ctx, state) {
    const s = state as { last?: [string, { at: string; result: Result }][]; events?: Report[] };
    for (const [k, val] of s.last ?? []) last.set(k, val);
    events = s.events ?? [];
  },
});
