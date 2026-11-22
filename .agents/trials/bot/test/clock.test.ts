import { expect, test } from "bun:test";
import { bench } from "racku/bench";
import { timeIn } from "../plugins/clock.ts";

test("timeIn formats a zone", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  expect(timeIn("Europe/Berlin", now)).toContain("13:00:00");
  expect(() => timeIn("Nowhere/Land", now)).toThrow();
});

test("the clock plugin offers /time", async () => {
  await using clock = await bench(new URL("../plugins/clock.ts", import.meta.url), { needs: {} });
  const list = await clock.call("commands", "list", undefined);
  expect(list.map((c) => c.name)).toEqual(["time"]);
  expect(String(await clock.call("commands", "run", { name: "time", input: "UTC" }))).toMatch(/\d{2}:\d{2}:\d{2}/);
});
