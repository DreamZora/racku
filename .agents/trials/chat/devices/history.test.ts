import { expect, test } from "bun:test";
import { bench } from "rack42u/bench";

const message = (room: string, n: number) => ({ room, user: "u", text: `m${n}`, at: n });

test("history keeps the last 20 messages of each room, oldest first", async () => {
  await using history = await bench(new URL("./history.ts", import.meta.url));
  for (let n = 1; n <= 25; n++) await history.call("history", "add", message("a", n));
  await history.call("history", "add", message("b", 1));
  const a = (await history.call("history", "recent", "a")) as { text: string }[];
  expect(a.length).toBe(20);
  expect(a[0]!.text).toBe("m6");
  expect(a[19]!.text).toBe("m25");
  expect(await history.call("history", "recent", "b")).toEqual([message("b", 1)]);
  expect(await history.call("history", "recent", "none")).toEqual([]);
});

test("history keeps its messages through a swap", async () => {
  await using history = await bench(new URL("./history.ts", import.meta.url));
  await history.call("history", "add", message("a", 1));
  await history.swap();
  expect(await history.call("history", "recent", "a")).toEqual([message("a", 1)]);
});
