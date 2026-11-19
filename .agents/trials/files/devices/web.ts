import { device, isRackError } from "rack42u";
import * as v from "valibot";
import { Files } from "../connectors.ts";

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * The HTTP side. It serves on a listener of its own, not behind the HTTP panel: the panel sends a
 * large body chunked, without `Content-Length`, and a file download needs one. The bytes of an
 * upload go to the store as a stream; a download is sent from the file itself, never held in memory.
 */
export default device({
  model: "web",
  needs: { files: Files },
  config: v.object({
    port: v.number(),
    maxSize: v.optional(v.number(), 50 * 1024 * 1024),
  }),

  async powerOn(ctx) {
    const { maxSize } = ctx.config;

    async function handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/files") {
        if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
        return json(await ctx.ports.files.list(undefined));
      }
      if (!path.startsWith("/files/")) return json({ error: "not found" }, 404);

      let name: string;
      try {
        name = decodeURIComponent(path.slice("/files/".length));
      } catch {
        return json({ error: "invalid name" }, 400);
      }
      if (!NAME.test(name)) return json({ error: "invalid name" }, 400);

      switch (request.method) {
        case "PUT": {
          const declared = request.headers.get("content-length");
          if (declared !== null && Number(declared) > maxSize) {
            return json({ error: "file too large" }, 413);
          }
          const bytes = request.body ?? new Blob([]).stream();
          try {
            const meta = await ctx.ports.files.put({ name, bytes });
            return json(meta, 201);
          } catch (error) {
            if (isRackError(error) && error.code === "TOO_LARGE") {
              return new Response(JSON.stringify({ error: "file too large" }), {
                status: 413,
                headers: { "content-type": "application/json", connection: "close" },
              });
            }
            throw error;
          }
        }
        case "GET":
        case "HEAD": {
          const found = await ctx.ports.files.locate(name);
          if (!found) return json({ error: "not found" }, 404);
          return new Response(request.method === "HEAD" ? null : Bun.file(found.path), {
            headers: {
              "content-length": String(found.size),
              "content-type": "application/octet-stream",
            },
          });
        }
        case "DELETE": {
          const removed = await ctx.ports.files.remove(name);
          return removed ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404);
        }
        default:
          return json({ error: "method not allowed" }, 405);
      }
    }

    await ctx.serve({
      port: ctx.config.port,
      maxRequestBodySize: maxSize + 1024 * 1024,
      idleTimeout: 60,
      async fetch(request) {
        try {
          return await handle(request);
        } catch (error) {
          ctx.log.error("request failed", { error: String(error) });
          return json({ error: "internal error" }, 500);
        }
      },
    });
    return {};
  },
});
