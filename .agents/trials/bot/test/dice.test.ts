import { expect, test } from "bun:test";
import { bench } from "racku/bench";
import { roll } from "../plugins/dice.ts";

test("roll sums the dice", () => {
  expect(roll("2d6", () => 0)).toBe("1 + 1 = 2");
  expect(roll("3d4", () => 0.999)).toBe("4 + 4 + 4 = 12");
  expect(() => roll("hello")).toThrow();
});

test("the dice plugin offers /roll", async () => {
  await using dice = await bench(new URL("../plugins/dice.ts", import.meta.url), { needs: {} });
  const list = await dice.call("commands", "list", undefined);
  expect(list.map((c) => c.name)).toEqual(["roll"]);
  expect(list[0]?.input).toMatchObject({ type: "string" });
  expect(String(await dice.call("commands", "run", { name: "roll", input: "1d1" }))).toBe("1 = 1");
});
