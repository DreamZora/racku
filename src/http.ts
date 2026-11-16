/**
 * The `http/v1` connector that the HTTP panel forwards requests through, and `httpHandler`,
 * which adapts a fetch-style function into an implementation of it.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#panel-http
 */
import * as v from "valibot";
import { connector, rpc } from "./connector.ts";
import type { CallContext, PortImpl } from "./device.ts";

const Header = v.tuple([v.string(), v.string()]);
const Body = v.nullable(v.instance(Uint8Array));

/** The request a panel sends through `http/v1`. */
export const HttpRequest = v.object({
  method: v.string(),
  url: v.string(),
  // Pairs instead of a record, so duplicate headers survive.
  headers: v.array(Header),
  params: v.record(v.string(), v.string()),
  body: Body,
});

/** The response a device returns through `http/v1`. */
export const HttpResponse = v.object({
  // `Response` accepts only these statuses.
  status: v.pipe(v.number(), v.integer(), v.minValue(200), v.maxValue(599)),
  headers: v.array(Header),
  body: Body,
});

/** The `http/v1` connector: one `handle` method per HTTP request. */
export const Http = connector("http/v1", { handle: rpc(HttpRequest, HttpResponse) });

/** A fetch-style request handler, such as the `fetch` of a routing library. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Wraps a fetch-style handler into an implementation of `http/v1`.
 *
 * The handler receives a standard `Request` whose `signal` aborts when the client goes away or
 * the call times out. Request and response bodies are copied in full; streaming is not supported.
 *
 * @param fetch The request handler.
 * @returns The port implementation to return from `powerOn`.
 */
export function httpHandler(fetch: FetchHandler): PortImpl<typeof Http.members> {
  return {
    async handle(input: v.InferOutput<typeof HttpRequest>, call: CallContext) {
      const request = new Request(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: call.signal,
      });
      const response = await fetch(request);
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") headers.push([name, value]);
      });
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      const body = response.body === null ? null : new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers, body };
    },
  };
}
