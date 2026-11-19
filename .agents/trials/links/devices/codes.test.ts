import { expect, test } from "bun:test";
import { bench } from "rack42u/bench";

test("codes makes codes of 6 letters and digits", async () => {
  await using codes = await bench(new URL("./codes.ts", import.meta.url), {});
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const code = (await codes.call("codes", "make", undefined)) as string;
    expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
    seen.add(code);
  }
  expect(seen.size).toBeGreaterThan(15);
});
