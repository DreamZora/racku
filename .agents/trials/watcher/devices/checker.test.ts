import { afterAll, expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Watch } from "../connectors.ts";

let body = "one";
let code = 200;
const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status: code }) });
afterAll(() => server.stop(true));
const url = `http://127.0.0.1:${server.port}/`;

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(50);
  expect(cond()).toBe(true);
}

function store(last: unknown = null) {
  return stub(Watch, { record: () => undefined, last: () => last as null, forget: () => undefined });
}

test("checker records its first result without a change", async () => {
  const watch = store();
  await using _ = await bench(new URL("./checker.ts", import.meta.url), {
    config: { url, interval: 1 },
    needs: { watch },
  });
  await until(() => watch.calls.some((c) => c.member === "record"));
  const call = watch.calls.find((c) => c.member === "record")!.input as any;
  expect(call.url).toBe(url);
  expect(call.result.status).toBe(200);
  expect(call.result.hash).toHaveLength(64);
  expect(call.from).toBeUndefined();
});

test("checker reports a change of body and of status, with the earlier result", async () => {
  body = "one";
  code = 200;
  const watch = store();
  await using _ = await bench(new URL("./checker.ts", import.meta.url), {
    config: { url, interval: 1 },
    needs: { watch },
  });
  const records = () => watch.calls.filter((c) => c.member === "record").map((c) => c.input as any);
  await until(() => records().length >= 1);
  body = "two";
  await until(() => records().some((r) => r.from));
  const changed = records().find((r) => r.from)!;
  expect(changed.from.hash).not.toBe(changed.result.hash);
  code = 503;
  await until(() => records().some((r) => r.from?.status === 200 && r.result.status === 503));
});

test("checker reports an error as a failure, and compares with what the store saw last", async () => {
  server.stop(true);
  const dead = url;
  const seen = { status: 200, hash: "x" };
  const watch = store(seen);
  await using _ = await bench(new URL("./checker.ts", import.meta.url), {
    config: { url: dead, interval: 1 },
    needs: { watch },
  });
  await until(() => watch.calls.some((c) => c.member === "record"));
  const call = watch.calls.find((c) => c.member === "record")!.input as any;
  expect(call.result.error).toBeString();
  expect(call.result.status).toBeUndefined();
  expect(call.from).toEqual(seen);
});
