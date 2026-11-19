import { device, isRackError } from "rack42u";
import { Http, httpHandler } from "rack42u/std";
import { Codes, Links } from "../connectors.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default device({
  model: "web",
  needs: { codes: Codes, links: Links },
  provides: { http: Http },

  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const { pathname } = new URL(request.url);
      const segments = pathname.split("/").filter(Boolean);

      if (request.method === "POST" && pathname === "/links") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "the body is not JSON" }, 400);
        }
        const url = (body as { url?: unknown } | null)?.url;
        if (typeof url !== "string") return json({ error: "url must be a string" }, 400);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return json({ error: "url is not an absolute URL" }, 400);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return json({ error: "url must use http: or https:" }, 400);
        }
        for (let attempt = 0; attempt < 10; attempt++) {
          const code = await ctx.ports.codes.make(undefined);
          try {
            await ctx.ports.links.add({ code, url });
            return json({ code, url }, 201);
          } catch (error) {
            if (isRackError(error) && error.code === "CODE_TAKEN") continue;
            throw error;
          }
        }
        return json({ error: "no free code" }, 500);
      }

      if (request.method === "GET" && segments.length === 2 && segments[0] === "links") {
        const link = await ctx.ports.links.get(segments[1] as string);
        return link ? json(link) : json({ error: "unknown code" }, 404);
      }

      if (request.method === "GET" && segments.length === 1) {
        const url = await ctx.ports.links.visit(segments[0] as string);
        return url ? new Response(null, { status: 302, headers: { Location: url } }) : json({ error: "unknown code" }, 404);
      }

      return json({ error: "not found" }, 404);
    }),
  }),
});
