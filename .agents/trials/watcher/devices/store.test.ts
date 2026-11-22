import { expect, test } from "bun:test";
import { bench } from "racku/bench";

const obs = (url: string, result: object) => ({ url, at: new Date().toISOString(), result });

test("store reports changes and failures, and serves them", async () => {
  await using store = await bench(new URL("./store.ts", import.meta.url));
  const observe = (url: string, result: object) => store.call("reports", "observe", obs(url, result));

  expect(await observe("http://a", { status: 200, hash: "1" })).toBe(false); // first, a success
  expect(await observe("http://a", { status: 200, hash: "1" })).toBe(false); // same
  expect(await observe("http://a", { status: 200, hash: "2" })).toBe(true); // other body
  expect(await observe("http://a", { error: "boom" })).toBe(true); // failure
  expect(await observe("http://a", { status: 200, hash: "2" })).toBe(true); // recovered
  expect(await observe("http://b", { error: "down" })).toBe(true); // first, a failure
  // The HTTP path of /events and /status is covered by check.ts.
});
