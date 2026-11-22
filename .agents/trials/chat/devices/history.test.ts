import { expect, test } from "bun:test";
import { bench } from "racku/bench";

const msg = (room: string, n: number) => ({ room, user: "ann", text: `m${n}`, at: n });

test("history keeps the last 20 messages of each room, oldest first", async () => {
  await using history = await bench(new URL("./history.ts", import.meta.url));
  for (let n = 1; n <= 25; n++) await history.call("history", "add", msg("a", n));
  await history.call("history", "add", msg("b", 1));
  const a = (await history.call("history", "recent", { room: "a" })) as { text: string }[];
  expect(a.map((m) => m.text)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 6}`));
  expect(await history.call("history", "recent", { room: "b" })).toEqual([msg("b", 1)]);
  expect(await history.call("history", "recent", { room: "none" })).toEqual([]);
});

test("history keeps its messages across a swap", async () => {
  await using history = await bench(new URL("./history.ts", import.meta.url));
  await history.call("history", "add", msg("a", 1));
  await history.swap();
  expect(await history.call("history", "recent", { room: "a" })).toEqual([msg("a", 1)]);
});
