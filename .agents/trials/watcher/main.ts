import { readFile } from "node:fs/promises";
import { start } from "rack42u";
import { buildRack, parseWatch, portFromEnv, type WatchConfig } from "./layout.ts";

/**
 * Runs the rack, and follows watch.json: a URL added gets a checker without a restart of
 * the others, and a URL removed loses its checker.
 */
export async function run(options: { watchFile: string; port: number; baseDir: string; pollMs?: number }) {
  const slots = new Map<string, number>();
  let config = parseWatch(await readFile(options.watchFile, "utf8"));
  const running = await start(buildRack(config, slots, options.port), { baseDir: options.baseDir });

  let text = JSON.stringify(config);
  let queue: Promise<unknown> = Promise.resolve();
  const poll = setInterval(() => {
    queue = queue.then(async () => {
      let next: WatchConfig;
      try {
        next = parseWatch(await readFile(options.watchFile, "utf8"));
      } catch (error) {
        return; // half-written or invalid: keep what runs
      }
      if (JSON.stringify(next) === text) return;
      const removed = config.urls.filter((u) => !next.urls.includes(u));
      text = JSON.stringify(next);
      config = next;
      const results = await running.reload(buildRack(next, slots, options.port));
      for (const r of results as { ok?: boolean; device?: string; error?: unknown }[]) {
        if (r.ok === false) console.error("reload failed", r);
      }
      for (const url of removed) await running.call("store.watch", "forget", url).catch(() => {});
    });
  }, options.pollMs ?? 1000);

  return {
    running,
    async stop() {
      clearInterval(poll);
      await queue;
      await running.stop();
    },
  };
}

if (import.meta.main) {
  const app = await run({
    watchFile: new URL("./watch.json", import.meta.url).pathname,
    port: portFromEnv(),
    baseDir: import.meta.dir,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.stop().then(() => process.exit(0)));
}
