import { rack, slot } from "rack42u";

export type WatchConfig = { interval: number; urls: string[] };

export const SIZE = 200;

/** Reads and checks watch.json's text; throws a message that says what is wrong. */
export function parseWatch(text: string): WatchConfig {
  const data = JSON.parse(text) as Partial<WatchConfig>;
  const interval = data.interval ?? 5;
  if (typeof interval !== "number" || !(interval > 0)) throw new Error("interval must be a positive number");
  if (!Array.isArray(data.urls) || data.urls.some((u) => typeof u !== "string")) {
    throw new Error("urls must be an array of strings");
  }
  return { interval, urls: [...new Set(data.urls)] };
}

/** Gives every URL a slot of its own, and keeps it while the URL stays in the list. */
export function assignSlots(urls: string[], slots: Map<string, number>): Map<string, number> {
  for (const url of [...slots.keys()]) if (!urls.includes(url)) slots.delete(url);
  const used = new Set(slots.values());
  for (const url of urls) {
    if (slots.has(url)) continue;
    let u = 2;
    while (used.has(u)) u++;
    used.add(u);
    slots.set(url, u);
  }
  return slots;
}

/** The manifest: the store in slot 1, and one checker of its own for each URL above it. */
export function buildRack(config: WatchConfig, slots: Map<string, number>, port: number) {
  assignSlots(config.urls, slots);
  const placed: Record<number, ReturnType<typeof slot>> = {
    1: slot("./devices/store.ts", { config: { port } }),
  };
  for (const [url, u] of slots) {
    placed[u] = slot("./devices/checker.ts", {
      name: `checker-${u}`,
      config: { url, interval: config.interval },
    });
  }
  return rack("watcher", { size: SIZE, slots: placed });
}

export const portFromEnv = () => Number(process.env.PORT ?? 3000);
