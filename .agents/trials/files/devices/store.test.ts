import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench } from "rack42u/bench";

const source = new URL("./store.ts", import.meta.url);

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      const part = parts.shift();
      if (part) controller.enqueue(part);
      else controller.close();
    },
  });
}

const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function withStore(maxSize: number, run: (store: Awaited<ReturnType<typeof bench>>, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "store-test-"));
  try {
    await using store = await bench(source, { config: { dir, maxSize }, needs: {} });
    await run(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("store puts a streamed file, lists it, locates it, and removes it", () =>
  withStore(1000, async (store) => {
    const data = new TextEncoder().encode("hello world");
    const meta = await store.call("files", "put", {
      name: "a.txt",
      bytes: streamOf(data.subarray(0, 5), data.subarray(5)),
    });
    expect(meta).toEqual({ name: "a.txt", size: 11, sha256: sha(data) });
    expect(await store.call("files", "list", undefined)).toEqual([meta]);
    const located = (await store.call("files", "locate", "a.txt")) as { path: string; size: number };
    expect(located.size).toBe(11);
    expect(await Bun.file(located.path).text()).toBe("hello world");
    expect(await store.call("files", "remove", "a.txt")).toBe(true);
    expect(await store.call("files", "remove", "a.txt")).toBe(false);
    expect(await store.call("files", "locate", "a.txt")).toBeNull();
  }));

test("store replaces a file and lists by name", () =>
  withStore(1000, async (store) => {
    for (const name of ["b", "a", "c"]) {
      await store.call("files", "put", { name, bytes: streamOf(new Uint8Array([1])) });
    }
    await store.call("files", "put", { name: "b", bytes: streamOf(new Uint8Array([1, 2, 3])) });
    const list = (await store.call("files", "list", undefined)) as { name: string; size: number }[];
    expect(list.map((f) => [f.name, f.size])).toEqual([["a", 1], ["b", 3], ["c", 1]]);
  }));

test("store refuses a file over its limit and leaves nothing", () =>
  withStore(10, async (store, dir) => {
    const error = await store
      .call("files", "put", { name: "big", bytes: streamOf(new Uint8Array(6), new Uint8Array(6)) })
      .catch((e) => e);
    expect(error.code).toBe("TOO_LARGE");
    expect(await store.call("files", "list", undefined)).toEqual([]);
    expect((await readdir(dir)).length).toBe(0);
    // A file of exactly the limit is fine.
    await store.call("files", "put", { name: "ok", bytes: streamOf(new Uint8Array(10)) });
  }));

test("store refuses bad names", () =>
  withStore(10, async (store) => {
    for (const name of [".x", "a/b", "", "x".repeat(101), "a b"]) {
      const error = await store.call("files", "put", { name, bytes: streamOf() }).catch((e) => e);
      expect(error.code).toBe("BAD_NAME");
      expect(await store.call("files", "locate", name)).toBeNull();
    }
  }));

test("store keeps its files over a cold swap and a restart", () =>
  withStore(1000, async (store) => {
    await store.call("files", "put", { name: "keep", bytes: streamOf(new Uint8Array([7, 7])) });
    await store.swap();
    expect(await store.call("files", "list", undefined)).toEqual([
      { name: "keep", size: 2, sha256: sha(new Uint8Array([7, 7])) },
    ]);
    await store.restart();
    expect((await store.call("files", "list", undefined)) as unknown[]).toHaveLength(1);
  }));
