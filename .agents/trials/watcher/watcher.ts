import { readFileSync, watch } from "node:fs";
import { rack, slot, start, type RackHandle, type StartOptions } from "rack42u";
import { httpPanel } from "rack42u/std";

export type WatchConfig = { interval: number; urls: string[] };

const here = new URL(".", import.meta.url).pathname;

/** Reads watch.json: the interval in seconds, and the URLs, without duplicates. */
export function readWatch(file: string): WatchConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchConfig>;
  const interval = typeof raw.interval === "number" && raw.interval > 0 ? raw.interval : 5;
  const urls = [...new Set((raw.urls ?? []).filter((u): u is string => typeof u === "string"))];
  return { interval, urls };
}

/** The name of the device that watches a URL. */
export const checkerName = (url: string) => `checker-${Bun.hash(url).toString(36)}`;

/** The manifest: the store, the panel above it, and one checker for each URL. */
export function layout(config: WatchConfig, port: number) {
  const slots: Record<number, ReturnType<typeof slot>> = {
    1: slot("./devices/store.ts"),
    2: httpPanel({ port, routes: { "/events": "store.http", "/status": "store.http" } }),
  };
  let u = 3;
  for (const url of config.urls) {
    slots[u++] = slot("./devices/checker.ts", { name: checkerName(url), config: { url, interval: config.interval } });
  }
  return rack("watcher", { size: Math.max(42, u + 8), slots });
}

export type Watcher = { rack: RackHandle; stop(): Promise<void> };

/** Runs the rack, and follows watch.json: a URL added to it gets a checker, one removed loses it. */
export async function run(
  options: { file?: string; port?: number } & Pick<StartOptions, "logger" | "faultInjection" | "watchdog">,
): Promise<Watcher> {
  const file = options.file ?? `${here}watch.json`;
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const { file: _f, port: _p, ...startOptions } = options;
  const running = await start(layout(readWatch(file), port), { baseDir: here, ...startOptions });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const apply = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await running.reload(layout(readWatch(file), port));
      } catch (error) {
        console.error("watch.json not applied:", String(error));
      }
    }, 100);
  };
  // Watch the directory, since editors replace the file.
  const dir = file.slice(0, file.lastIndexOf("/"));
  const base = file.slice(file.lastIndexOf("/") + 1);
  const watcher = watch(dir, (_event, name) => {
    if (name === base) apply();
  });

  return {
    rack: running,
    async stop() {
      watcher.close();
      clearTimeout(timer);
      await running.stop();
    },
  };
}

if (import.meta.main) {
  const watcher = await run({});
  const stop = () => void watcher.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
