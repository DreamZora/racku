import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { device, fileResponse } from "rack42u";
import * as v from "valibot";

const MiB = 1024 * 1024;

const Config = v.object({
  port: v.optional(v.number(), 3000),
  /** The largest file, in bytes. */
  maxSize: v.optional(v.number(), 50 * MiB),
  /** The directory of the files, relative to the rack's base directory. */
  dir: v.optional(v.string(), "data/files"),
});

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

type Info = { name: string; size: number; sha256: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (status: number, message: string) => new Response(message, { status });

export default device({
  model: "files",
  // Two writers could break a file: the old instance stops before the new one starts.
  swap: "cold",
  provides: {},
  config: Config,

  async powerOn(ctx) {
    const root = join(ctx.baseDir, ctx.config.dir);
    const metaDir = join(root, ".meta");
    const tmpDir = join(root, ".tmp");
    const max = ctx.config.maxSize;
    await mkdir(metaDir, { recursive: true });
    // Leftovers of an upload that a crash cut short.
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const filePath = (name: string) => join(root, name);
    const metaPath = (name: string) => join(metaDir, `${name}.json`);

    async function sha256Of(path: string): Promise<string> {
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
      return hasher.digest("hex");
    }

    async function info(name: string): Promise<Info | undefined> {
      let size: number;
      try {
        const s = await stat(filePath(name));
        if (!s.isFile()) return undefined;
        size = s.size;
      } catch {
        return undefined;
      }
      try {
        const meta = JSON.parse(await readFile(metaPath(name), "utf8")) as Info;
        if (meta.size === size) return { name, size, sha256: meta.sha256 };
      } catch {}
      const sha256 = await sha256Of(filePath(name));
      await writeFile(metaPath(name), JSON.stringify({ name, size, sha256 }));
      return { name, size, sha256 };
    }

    // Commits are serialised, so a file and its metadata change together.
    let commitChain: Promise<unknown> = Promise.resolve();
    const serial = <T>(task: () => Promise<T>): Promise<T> => {
      const run = commitChain.then(task, task);
      commitChain = run.catch(() => {});
      return run;
    };

    let uploads = 0;
    async function put(name: string, request: Request): Promise<Response> {
      const declared = request.headers.get("content-length");
      if (declared !== null && Number(declared) > max) return text(413, "file too large");
      const tmp = join(tmpDir, `${Date.now()}-${uploads++}`);
      const handle = await open(tmp, "w");
      const hasher = new Bun.CryptoHasher("sha256");
      let size = 0;
      try {
        if (request.body) {
          for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength;
            if (size > max) {
              await handle.close();
              await rm(tmp, { force: true });
              return text(413, "file too large");
            }
            hasher.update(chunk);
            await handle.write(chunk);
          }
        }
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(tmp, { force: true });
        throw error;
      }
      const sha256 = hasher.digest("hex");
      await serial(async () => {
        await writeFile(metaPath(name), JSON.stringify({ name, size, sha256 }));
        await rename(tmp, filePath(name));
      });
      return json({ name, size, sha256 }, 201);
    }

    async function list(): Promise<Info[]> {
      const names = (await readdir(root)).filter((n) => NAME.test(n)).sort();
      const infos = await Promise.all(names.map(info));
      return infos.filter((i): i is Info => i !== undefined);
    }

    async function handle(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/files") {
        if (request.method !== "GET") return text(405, "method not allowed");
        return json(await list());
      }
      if (!pathname.startsWith("/files/")) return text(404, "not found");
      const name = pathname.slice("/files/".length);
      if (!NAME.test(name)) return text(400, "invalid name");
      switch (request.method) {
        case "PUT":
          return put(name, request);
        case "GET": {
          const found = await info(name);
          if (!found) return text(404, "not found");
          return fileResponse(filePath(name), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        case "DELETE": {
          const removed = await serial(async () => {
            if (!(await info(name))) return false;
            await rm(filePath(name), { force: true });
            await rm(metaPath(name), { force: true });
            return true;
          });
          return removed ? new Response(null, { status: 204 }) : text(404, "not found");
        }
        default:
          return text(405, "method not allowed");
      }
    }

    const web = await ctx.serve({
      port: ctx.config.port,
      maxRequestBodySize: max + MiB,
      idleTimeout: 120,
      fetch: (request) => handle(request),
      error: (error) => {
        ctx.log.error("request failed", { error: String(error) });
        return text(500, "internal error");
      },
    });
    ctx.log.info("serving files", { url: web.url.href });
    return {};
  },
});
