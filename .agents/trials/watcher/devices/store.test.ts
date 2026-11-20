import { expect, test } from "bun:test";
import { bench } from "rack42u/bench";

const ok = (hash: string) => ({ status: 200, error: null, hash });
const failed = { status: null, error: "timeout", hash: null };

/** Calls the store's HTTP port as the panel would. */
async function get(store: Awaited<ReturnType<typeof bench>>, path: string) {
  const answer = (await store.call("http", "handle", {
    method: "GET",
    url: `http://x${path}`,
    headers: [],
    params: {},
    body: null,
  })) as { status: number; body: Uint8Array | null };
  const text = new TextDecoder().decode(answer.body ?? new Uint8Array());
  return { status: answer.status, json: answer.status === 200 ? JSON.parse(text) : text };
}

test("store keeps the last result of each URL and the last 100 reports, newest first", async () => {
  await using store = await bench(new URL("./store.ts", import.meta.url), { needs: {} });
  await store.call("reports", "record", { url: "a", at: "t1", result: ok("1"), change: null });
  for (let i = 0; i < 105; i++) {
    await store.call("reports", "record", {
      url: "a",
      at: `c${i}`,
      result: ok(String(i)),
      change: { from: ok("x"), to: ok(String(i)) },
    });
  }
  await store.call("reports", "record", { url: "b", at: "t2", result: failed, change: null });

  expect(await store.call("reports", "last", "b")).toEqual(failed);
  expect(await store.call("reports", "last", "zzz")).toBeNull();

  const events = await get(store, "/events");
  expect(events.status).toBe(200);
  expect(events.json).toHaveLength(100);
  expect(events.json[0]).toEqual({ url: "a", at: "c104", from: ok("x"), to: ok("104") });
  expect(events.json[99].at).toBe("c5");

  const status = await get(store, "/status");
  expect(status.json).toEqual([
    { url: "a", at: "c104", result: ok("104") },
    { url: "b", at: "t2", result: failed },
  ]);
  expect((await get(store, "/nope")).status).toBe(404);
});

test("store keeps its reports through a hot swap", async () => {
  await using store = await bench(new URL("./store.ts", import.meta.url), { needs: {} });
  await store.call("reports", "record", {
    url: "a",
    at: "t",
    result: failed,
    change: { from: ok("1"), to: failed },
  });
  await store.swap();
  expect((await get(store, "/events")).json).toHaveLength(1);
  expect(await store.call("reports", "last", "a")).toEqual(failed);
});
