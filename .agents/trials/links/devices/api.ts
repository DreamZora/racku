import { device, RackError } from "racku";
import { Http, httpHandler } from "racku/std";
import { Codes, Links } from "../connectors.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export default device({
  model: "api",
  needs: { codes: Codes, links: Links },
  provides: { http: Http },

  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/links") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "the body is not JSON" }, 400);
        }
        const url = parseUrl((body as { url?: unknown } | null)?.url);
        if (url === undefined) return json({ error: "url must be an absolute http: or https: URL" }, 400);
        for (let attempt = 0; attempt < 10; attempt++) {
          const code = await ctx.ports.codes.make(undefined);
          try {
            return json(await ctx.ports.links.add({ code, url }), 201);
          } catch (error) {
            if (error instanceof RackError && error.code === "LINK_TAKEN") continue;
            throw error;
          }
        }
        return json({ error: "no free code" }, 503);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "use GET" }, 405);
      if (path.startsWith("/links/")) {
        const link = await ctx.ports.links.get(decodeURIComponent(path.slice(7)));
        return link ? json(link) : json({ error: "not found" }, 404);
      }
      const url = await ctx.ports.links.visit(decodeURIComponent(path.slice(1)));
      return url ? new Response(null, { status: 302, headers: { Location: url } }) : json({ error: "not found" }, 404);
    }),
  }),
});
