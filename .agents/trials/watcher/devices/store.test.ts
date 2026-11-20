import { expect, test } from "bun:test";
import { bench } from "rack42u/bench";

const ok = { status: 200, hash: "a" };
const bad = { error: "TimeoutError" };

async function open() {
  const store = await bench(new URL("./store.ts", import.meta.url), { config: { port: 0 } });
  const [{ url }] = (await store.rack.status())[0]!.listeners;
  return { store, base: String(url).replace(/\/$/, "") };
}

test("store keeps reports of changes, newest first, and the last result of each URL", async () => {
  const { store, base } = await open();
  await using _ = store;
  await store.call("watch", "record", { url: "u1", at: 1, result: ok });
  await store.call("watch", "record", { url: "u1", at: 2, result: bad, from: ok });
  await store.call("watch", "record", { url: "u1", at: 3, result: ok, from: bad });

  const events = (await (await fetch(`${base}/events`)).json()) as any[];
  expect(events.map((e) => e.at)).toEqual([3, 2]);
  expect(events[1]).toEqual({ url: "u1", at: 2, from: ok, to: bad });
  expect(await (await fetch(`${base}/status`)).json()).toEqual([{ url: "u1", at: 3, result: ok }]);
  expect(await store.call("watch", "last", "u1")).toEqual(ok);
  expect(await store.call("watch", "last", "other")).toBeNull();
});

test("store keeps the last 100 reports", async () => {
  const { store, base } = await open();
  await using _ = store;
  for (let i = 1; i <= 120; i++) {
    await store.call("watch", "record", { url: "u", at: i, result: ok, from: bad });
  }
  const events = (await (await fetch(`${base}/events`)).json()) as any[];
  expect(events.length).toBe(100);
  expect(events[0].at).toBe(120);
});

test("store forgets a URL, and keeps its state through a swap", async () => {
  const { store, base } = await open();
  await using _ = store;
  await store.call("watch", "record", { url: "a", at: 1, result: ok });
  await store.call("watch", "record", { url: "b", at: 2, result: bad, from: ok });
  await store.call("watch", "forget", "a");
  await store.swap();
  expect(await store.call("watch", "last", "a")).toBeNull();
  expect(await store.call("watch", "last", "b")).toEqual(bad);
  expect(((await (await fetch(`${base}/events`)).json()) as any[]).length).toBe(1);
});

test("store answers 404 and 405", async () => {
  const { store, base } = await open();
  await using _ = store;
  expect((await fetch(`${base}/nothing`)).status).toBe(404);
  expect((await fetch(`${base}/events`, { method: "POST" })).status).toBe(405);
});
