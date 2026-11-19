import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { device, RackError } from "rack42u";
import * as v from "valibot";
import { Files } from "../connectors.ts";

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new RackError("BAD_NAME", `invalid file name: ${name}`);
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * The only device that writes the files. It never runs twice at once, so two writers can't
 * break a file: a swap of it is cold.
 */
export default device({
  model: "store",
  swap: "cold",
  provides: { files: Files },
  config: v.object({
    dir: v.optional(v.string(), "data/files"),
    maxSize: v.optional(v.number(), 50 * 1024 * 1024),
  }),

  async powerOn(ctx) {
    const dir = resolve(ctx.baseDir, ctx.config.dir);
    const max = ctx.config.maxSize;
    await mkdir(dir, { recursive: true });
    // Uploads that a stop or a crash cut short leave only temporary files.
    for (const entry of await readdir(dir)) {
      if (entry.startsWith(".tmp-")) await rm(join(dir, entry), { force: true });
    }

    // Hashes of files that were found, by name, valid while the size and mtime stay.
    const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

    async function meta(name: string) {
      const path = join(dir, name);
      let info;
      try {
        info = await stat(path);
      } catch {
        hashes.delete(name);
        return null;
      }
      if (!info.isFile()) return null;
      let known = hashes.get(name);
      if (!known || known.size !== info.size || known.mtimeMs !== info.mtimeMs) {
        known = { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256Of(path) };
        hashes.set(name, known);
      }
      return { name, path, size: info.size, sha256: known.sha256 };
    }

    return {
      files: {
        async put({ name, bytes }) {
          checkName(name);
          const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
          const hasher = new Bun.CryptoHasher("sha256");
          const sink = Bun.file(tmp).writer();
          let size = 0;
          try {
            for await (const chunk of bytes) {
              size += chunk.byteLength;
              if (size > max) {
                throw new RackError("TOO_LARGE", `a file may have up to ${max} bytes`);
              }
              hasher.update(chunk);
              sink.write(chunk);
              await sink.flush();
            }
            await sink.end();
            await rename(tmp, join(dir, name));
          } catch (error) {
            await Promise.resolve(sink.end()).catch(() => {});
            await rm(tmp, { force: true });
            throw error;
          }
          const sha256 = hasher.digest("hex");
          const info = await stat(join(dir, name));
          hashes.set(name, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
          return { name, size, sha256 };
        },

        async list() {
          const found = [];
          for (const entry of await readdir(dir)) {
            if (!NAME.test(entry)) continue;
            const m = await meta(entry);
            if (m) found.push({ name: m.name, size: m.size, sha256: m.sha256 });
          }
          return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        },

        async locate(name) {
          if (!NAME.test(name)) return null;
          const m = await meta(name);
          return m && { path: m.path, size: m.size, sha256: m.sha256 };
        },

        async remove(name) {
          if (!NAME.test(name)) return false;
          hashes.delete(name);
          try {
            await rm(join(dir, name));
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        },
      },
    };
  },
});
