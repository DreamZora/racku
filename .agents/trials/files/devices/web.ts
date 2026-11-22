import { device, fileResponse, RackError } from "racku";
import { Http, httpHandler } from "racku/std";
import { Files } from "../connectors.ts";

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const MAX = 50 * 1024 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

export default device({
  model: "web",
  needs: { files: Files },
  provides: { http: Http },

  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const url = new URL(request.url);
      const method = request.method;
      if (url.pathname === "/files") {
        if (method !== "GET" && method !== "HEAD") return error(405, "method not allowed");
        return json(await ctx.ports.files.list(undefined));
      }
      const match = /^\/files\/(.*)$/.exec(url.pathname);
      if (!match) return error(404, "not found");
      let name: string;
      try {
        name = decodeURIComponent(match[1]!);
      } catch {
        return error(400, "invalid name");
      }
      if (!NAME.test(name)) return error(400, "invalid name");

      if (method === "PUT") {
        const declared = Number(request.headers.get("content-length") ?? 0);
        if (declared > MAX) return error(413, "file too large");
        try {
          const info = await ctx.ports.files.put({
            name,
            bytes: request.body ?? new Blob([]).stream(),
          });
          return json(info, 201);
        } catch (e) {
          if (e instanceof RackError && e.code === "TOO_LARGE") return error(413, "file too large");
          throw e;
        }
      }
      if (method === "GET" || method === "HEAD") {
        const found = await ctx.ports.files.stat(name);
        if (!found) return error(404, "not found");
        return fileResponse(found.path, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (method === "DELETE") {
        return (await ctx.ports.files.remove(name))
          ? new Response(null, { status: 204 })
          : error(404, "not found");
      }
      return error(405, "method not allowed");
    }),
  }),
});
