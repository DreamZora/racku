import { watch, readFileSync } from "node:fs";
import { rack, slot, start, type RunningRack } from "racku";
import { httpPanel } from "racku/std";

export type Watch = { interval: number; urls: string[] };

export function readWatch(file: string): Watch {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Watch>;
  return {
    interval: typeof raw.interval === "number" && raw.interval > 0 ? raw.interval : 5,
    urls: Array.isArray(raw.urls) ? [...new Set(raw.urls.filter((u) => typeof u === "string"))] : [],
  };
}

/** The checker of a URL is named after the URL's hash, so it keeps its name as the list changes. */
export const checkerName = (url: string) => `checker-${Bun.hash(url).toString(16)}`;

export function layout(watched: Watch, port: number) {
  const slots: Record<number, ReturnType<typeof slot> | ReturnType<typeof httpPanel>> = {
    1: slot("./devices/store.ts"),
    2: httpPanel({ port, routes: { "/events": "store.http", "/status": "store.http" } }),
  };
  let u = 3;
  for (const url of watched.urls) {
    slots[u++] = slot("./devices/checker.ts", {
      name: checkerName(url),
      config: { url, interval: watched.interval },
    });
  }
  return rack("watcher", { slots });
}

export type Launched = { running: RunningRack; stop(): Promise<void> };

/** Runs the rack, and follows `watchFile`: a changed list reloads the layout. */
export async function launch(options: {
  watchFile: string;
  port: number;
  baseDir: string;
  logger?: (entry: unknown) => void;
  faultInjection?: boolean;
  watchdog?: number;
}): Promise<Launched> {
  const read = () => {
    try {
      return readWatch(options.watchFile);
    } catch {
      return null;
    }
  };
  let current = read() ?? { interval: 5, urls: [] };
  const running = await start(layout(current, options.port), {
    baseDir: options.baseDir,
    ...(options.logger ? { logger: options.logger as never } : {}),
    faultInjection: options.faultInjection,
    watchdog: options.watchdog,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      chain = chain.then(async () => {
        const next = read();
        if (!next || JSON.stringify(next) === JSON.stringify(current)) return;
        current = next;
        await running.reload(layout(next, options.port)).catch(() => {});
      });
    }, 100);
  };
  const watcher = watch(options.watchFile, refresh);
  const poll = setInterval(refresh, 1000);

  return {
    running,
    async stop() {
      watcher.close();
      clearInterval(poll);
      clearTimeout(timer);
      await chain;
      await running.stop();
    },
  };
}
