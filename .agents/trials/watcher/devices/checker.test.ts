import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Reports } from "../connectors.ts";

async function until(condition: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

test("checker reports its URL's change from one body to another, and from success to failure", async () => {
  let body = "one";
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
  try {
    const seen: any[] = [];
    await using checker = await bench(new URL("./checker.ts", import.meta.url), {
      config: { url: `http://127.0.0.1:${server.port}/`, interval: 1 },
      needs: {
        store: stub(Reports, {
          record(o) {
            seen.push(o);
          },
          last: () => null,
        }),
      },
    });
    await until(() => seen.length >= 1);
    expect(seen[0].result.status).toBe(200);
    expect(seen[0].change).toBeNull();

    body = "two";
    await until(() => seen.some((o) => o.change));
    const changed = seen.find((o) => o.change);
    expect(changed.change.from.hash).not.toBe(changed.change.to.hash);

    await server.stop(true);
    await until(() => seen.some((o) => o.change?.to.error));
    const failure = seen.find((o) => o.change?.to.error);
    expect(failure.change.from.status).toBe(200);
    expect(failure.change.to.status).toBeNull();
    expect(checker.faults).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("a restarted checker takes its last result from the store, and reports a change against it", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("now") });
  try {
    const seen: any[] = [];
    const previous = { status: 200, error: null, hash: "old" };
    await using checker = await bench(new URL("./checker.ts", import.meta.url), {
      config: { url: `http://127.0.0.1:${server.port}/`, interval: 1 },
      needs: {
        store: stub(Reports, {
          record(o) {
            seen.push(o);
          },
          last: () => previous,
        }),
      },
    });
    await until(() => seen.length >= 1);
    expect(seen[0].change.from).toEqual(previous);
    await checker.restart();
    await until(() => seen.length >= 2);
    expect(checker.needs.store.calls.some((c) => c.member === "last")).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("a fetch that never answers counts as a failure within 10 s", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const seen: any[] = [];
    await using checker = await bench(new URL("./checker.ts", import.meta.url), {
      config: { url: `http://127.0.0.1:${server.port}/`, interval: 1 },
      needs: { store: stub(Reports, { record: (o) => void seen.push(o), last: () => null }) },
    });
    await until(() => seen.length >= 1, 14_000);
    expect(seen[0].result).toEqual({ status: null, error: "timeout", hash: null });
    expect(checker.faults).toEqual([]);
  } finally {
    await server.stop(true);
  }
}, 20_000);
