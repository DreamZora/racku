import { device } from "rack42u";
import { Http, httpHandler } from "rack42u/std";
import { Codes, Store } from "../connectors.ts";

function parseUrl(value: unknown): URL | string {
  if (typeof value !== "string") return "url must be a string";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "url must be an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must use http: or https:";
  return url;
}

export default device({
  model: "links-web",
  needs: { store: Store, codes: Codes },
  provides: { http: Http },

  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/links") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "body must be JSON" }, { status: 400 });
        }
        const url = parseUrl((body as { url?: unknown } | null)?.url);
        if (typeof url === "string") return Response.json({ error: url }, { status: 400 });
        for (let attempt = 0; attempt < 10; attempt++) {
          const code = await ctx.ports.codes.make(undefined);
          if (await ctx.ports.store.create({ code, url: url.href })) {
            return Response.json({ code, url: url.href }, { status: 201 });
          }
        }
        return Response.json({ error: "no free code" }, { status: 503 });
      }
      if (request.method === "GET") {
        const info = path.match(/^\/links\/([^/]+)$/);
        if (info) {
          const link = await ctx.ports.store.get(decodeURIComponent(info[1]!));
          return link ? Response.json(link) : Response.json({ error: "unknown code" }, { status: 404 });
        }
        const visit = path.match(/^\/([^/]+)$/);
        if (visit) {
          const url = await ctx.ports.store.visit(decodeURIComponent(visit[1]!));
          if (url) return new Response(null, { status: 302, headers: { location: url } });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }),
  }),
});
