import { expect, test } from "bun:test";
import { bench, stub } from "racku/bench";
import { Reports } from "../connectors.ts";

test("checker fetches its URL and reports body hash and errors", async () => {
  let body = "one";
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
  const seen: { url: string; result: { status?: number; hash?: string; error?: string } }[] = [];
  try {
    await using checker = await bench(new URL("./checker.ts", import.meta.url), {
      config: { url: `http://127.0.0.1:${server.port}/`, interval: 1 },
      needs: {
        reports: stub(Reports, {
          observe: (o) => {
            seen.push(o);
            return false;
          },
        }),
      },
    });
    await Bun.sleep(300);
    expect(seen[0]?.result.status).toBe(200);
    const first = seen[0]?.result.hash;
    body = "two";
    await Bun.sleep(1300);
    expect(seen.at(-1)?.result.hash).not.toBe(first);
    await server.stop(true);
    await Bun.sleep(1300);
    expect(seen.at(-1)?.result.error).toBeString();
    expect(checker.faults).toEqual([]);
  } finally {
    await server.stop(true);
  }
});
