import { expect, test } from "bun:test";
import { bench } from "racku/bench";
import { findWord } from "../plugins/wordfilter.ts";

test("findWord matches whole words, any case", () => {
  expect(findWord("Some SPAM here")).toBe("spam");
  expect(findWord("spamming is fine")).toBeUndefined();
});

test("the filter plugin refuses and accepts", async () => {
  await using f = await bench(new URL("../plugins/wordfilter.ts", import.meta.url), { needs: {} });
  expect(await f.call("filter", "check", { user: "u", text: "hello" })).toEqual({ ok: true });
  const no = await f.call("filter", "check", { user: "u", text: "so forbidden" });
  expect(no.ok).toBe(false);
  expect(no.reason).toContain("forbidden");
});
