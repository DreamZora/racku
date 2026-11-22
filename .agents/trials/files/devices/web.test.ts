import { expect, test } from "bun:test";
import { RackError } from "racku";
import { bench, stub } from "racku/bench";
import { Files } from "../connectors.ts";

async function open() {
  const stored = new Map<string, Uint8Array>();
  const b = await bench(new URL("./web.ts", import.meta.url), {
    needs: {
      files: stub(Files, {
        async put({ name, bytes }) {
          const data = new Uint8Array(await new Response(bytes).arrayBuffer());
          if (data.byteLength > 5) throw new RackError("TOO_LARGE", "big");
          stored.set(name, data);
          return { name, size: data.byteLength, sha256: "h" };
        },
        stat: (name) =>
          stored.has(name)
            ? { name, size: stored.get(name)!.byteLength, sha256: "h", path: "/nonexistent" }
            : null,
        list: () => [...stored].map(([name, d]) => ({ name, size: d.byteLength, sha256: "h" })),
        remove: (name) => stored.delete(name),
      }),
    },
  });
  return { b, stored };
}

type Res = { status: number; headers: [string, string][]; body: Uint8Array | null };

async function call(b: Awaited<ReturnType<typeof open>>["b"], method: string, path: string, body?: string) {
  return (await b.call("http", "handle", {
    method,
    url: `http://x${path}`,
    headers: [],
    params: {},
    body: body === undefined ? null : new TextEncoder().encode(body),
  })) as Res;
}

test("web puts, lists and deletes through the store", async () => {
  const { b, stored } = await open();
  await using _ = b;
  const put = await call(b, "PUT", "/files/a.txt", "hi");
  expect(put.status).toBe(201);
  expect(JSON.parse(new TextDecoder().decode(put.body!))).toEqual({ name: "a.txt", size: 2, sha256: "h" });
  expect(stored.has("a.txt")).toBe(true);
  const list = await call(b, "GET", "/files");
  expect(JSON.parse(new TextDecoder().decode(list.body!))).toHaveLength(1);
  expect((await call(b, "DELETE", "/files/a.txt")).status).toBe(204);
  expect((await call(b, "DELETE", "/files/a.txt")).status).toBe(404);
  expect((await call(b, "GET", "/files/a.txt")).status).toBe(404);
});

test("web answers 400 for bad names and 413 for a too large file", async () => {
  const { b } = await open();
  await using _ = b;
  expect((await call(b, "PUT", "/files/.hid", "x")).status).toBe(400);
  expect((await call(b, "PUT", "/files/a%2Fb", "x")).status).toBe(400);
  expect((await call(b, "PUT", `/files/${"a".repeat(101)}`, "x")).status).toBe(400);
  expect((await call(b, "PUT", "/files/big", "123456789")).status).toBe(413);
});
