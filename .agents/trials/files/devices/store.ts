import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { device, RackError } from "racku";
import * as v from "valibot";
import { Files } from "../connectors.ts";

const MAX_DEFAULT = 50 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

const Meta = v.object({ size: v.number(), sha256: v.string() });

// One writer per name at a time inside this instance. The device is cold-swapped,
// so no second instance writes the directory.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(name: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(name) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  chains.set(name, tail);
  void tail.then(() => {
    if (chains.get(name) === tail) chains.delete(name);
  });
  return run;
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

export default device({
  model: "store",
  swap: "cold",
  config: v.object({
    dir: v.optional(v.string(), "data/files"),
    maxSize: v.optional(v.number(), MAX_DEFAULT),
  }),
  provides: { files: Files },

  async powerOn(ctx) {
    const dir = resolve(ctx.baseDir, ctx.config.dir);
    const metaDir = join(dir, ".meta");
    const max = ctx.config.maxSize;
    await mkdir(metaDir, { recursive: true });
    // Leftovers of an interrupted upload: no other instance runs, so they are dead.
    for (const entry of await readdir(dir)) {
      if (entry.startsWith(".tmp-")) await rm(join(dir, entry), { force: true });
    }

    const checkName = (name: string) => {
      if (!NAME.test(name)) throw new RackError("BAD_NAME", "invalid file name");
    };

    async function info(name: string) {
      const path = join(dir, name);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return null;
      }
      const metaFile = Bun.file(join(metaDir, name));
      try {
        const meta = v.parse(Meta, await metaFile.json());
        if (meta.size === size) return { name, size, sha256: meta.sha256, path };
      } catch {}
      const sha256 = await hashFile(path);
      await Bun.write(metaFile, JSON.stringify({ size, sha256 }));
      return { name, size, sha256, path };
    }

    return {
      files: {
        put: ({ name, bytes }) => {
          checkName(name);
          return serial(name, async () => {
            const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
            const sink = Bun.file(tmp).writer();
            const hasher = new Bun.CryptoHasher("sha256");
            let size = 0;
            try {
              const reader = bytes.getReader();
              for (;;) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                size += chunk.byteLength;
                if (size > max) {
                  void reader.cancel().catch(() => {});
                  throw new RackError("TOO_LARGE", "file too large");
                }
                hasher.update(chunk);
                sink.write(chunk);
              }
              await sink.end();
              const sha256 = hasher.digest("hex");
              await Bun.write(join(metaDir, name), JSON.stringify({ size, sha256 }));
              await rename(tmp, join(dir, name));
              return { name, size, sha256 };
            } catch (error) {
              await Promise.resolve(sink.end()).catch(() => {});
              await rm(tmp, { force: true });
              throw error;
            }
          });
        },
        stat: (name) => {
          if (!NAME.test(name)) return null;
          return serial(name, () => info(name));
        },
        async list() {
          const out = [];
          for (const entry of (await readdir(dir)).filter((n) => NAME.test(n)).sort()) {
            const i = await serial(entry, () => info(entry));
            if (i) out.push({ name: i.name, size: i.size, sha256: i.sha256 });
          }
          return out;
        },
        remove: (name) => {
          if (!NAME.test(name)) return false;
          return serial(name, async () => {
            const existed = await Bun.file(join(dir, name)).exists();
            await rm(join(dir, name), { force: true });
            await rm(join(metaDir, name), { force: true });
            return existed;
          });
        },
      },
    };
  },
});
