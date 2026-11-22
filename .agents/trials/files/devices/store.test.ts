import { expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { bench } from "racku/bench";

function bytes(...parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
      controller.close();
    },
  });
}

let n = 0;
let base = "";
async function open(maxSize?: number) {
  base = new URL(`../scratch/bench-store-${process.pid}-${n++}/`, import.meta.url).pathname;
  await mkdir(base, { recursive: true });
  return bench(new URL("./store.ts", import.meta.url), {
    baseDir: base,
    config: maxSize ? { maxSize } : {},
  });
}

test("store puts, stats, lists, and removes files", async () => {
  await using store = await open();
  const put = await store.call("files", "put", { name: "b.txt", bytes: bytes("hel", "lo") });
  expect(put).toEqual({
    name: "b.txt",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  });
  await store.call("files", "put", { name: "a.txt", bytes: bytes("x") });
  const list = (await store.call("files", "list", undefined)) as { name: string }[];
  expect(list.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  const stat = (await store.call("files", "stat", "b.txt")) as { path: string; size: number };
  expect(stat.size).toBe(5);
  expect(await Bun.file(stat.path).text()).toBe("hello");
  expect(await store.call("files", "stat", "nope")).toBeNull();
  expect(await store.call("files", "remove", "b.txt")).toBe(true);
  expect(await store.call("files", "remove", "b.txt")).toBe(false);
});

test("store replaces a file, and refuses a larger one without leaving a file", async () => {
  await using store = await open(10);
  await store.call("files", "put", { name: "f", bytes: bytes("one") });
  await store.call("files", "put", { name: "f", bytes: bytes("three") });
  expect(((await store.call("files", "list", undefined)) as { size: number }[])[0]?.size).toBe(5);
  const failure = await store
    .call("files", "put", { name: "big", bytes: bytes("123456", "123456") })
    .catch((e: unknown) => e);
  console.log("failure", String(failure));
  expect((failure as { code: string }).code).toBe("TOO_LARGE");
  expect(await store.call("files", "stat", "big")).toBeNull();
  expect((await readdir(`${base}data/files`)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
});

test("store keeps its files across a cold swap and a restart", async () => {
  await using store = await open();
  await store.call("files", "put", { name: "k", bytes: bytes("keep") });
  await store.swap();
  expect(store.rack.history()[0]).toMatchObject({ mode: "cold", ok: true });
  await store.restart();
  expect(((await store.call("files", "list", undefined)) as { name: string }[]).map((f) => f.name)).toEqual(["k"]);
});

test("store refuses invalid names", async () => {
  await using store = await open();
  await expect(
    store.call("files", "put", { name: ".hidden", bytes: bytes("x") }),
  ).rejects.toMatchObject({ code: "BAD_NAME" });
});
