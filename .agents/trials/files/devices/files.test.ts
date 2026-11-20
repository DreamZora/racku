import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { bench } from "rack42u/bench";

async function open(maxSize = 1024) {
  // Inside the app, so that the firmware finds rack42u and valibot.
  const scratch = join(import.meta.dir, "..", "scratch");
  await mkdir(scratch, { recursive: true });
  const baseDir = await mkdtemp(join(scratch, "files-test-"));
  const device = await bench(new URL("./files.ts", import.meta.url), {
    baseDir,
    config: { port: 0, maxSize },
  });
  const status = device.rack.status().find((s) => s.name === "files");
  const url = (status as any).listeners[0].url as string;
  return { device, url: url.replace(/\/$/, ""), baseDir };
}

test("files stores, lists, serves, and deletes", async () => {
  const { device, url, baseDir } = await open();
  try {
    const put = await fetch(`${url}/files/b.txt`, { method: "PUT", body: "hello" });
    expect(put.status).toBe(201);
    const hello = new Bun.CryptoHasher("sha256").update("hello").digest("hex");
    expect(await put.json()).toEqual({ name: "b.txt", size: 5, sha256: hello });
    await fetch(`${url}/files/a`, { method: "PUT", body: "x" });
    const list = (await (await fetch(`${url}/files`)).json()) as { name: string }[];
    expect(list.map((f) => f.name)).toEqual(["a", "b.txt"]);

    const got = await fetch(`${url}/files/b.txt`);
    expect(got.headers.get("content-length")).toBe("5");
    expect(await got.text()).toBe("hello");

    await fetch(`${url}/files/b.txt`, { method: "PUT", body: "hi" });
    expect(await (await fetch(`${url}/files/b.txt`)).text()).toBe("hi");

    expect((await fetch(`${url}/files/b.txt`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${url}/files/b.txt`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${url}/files/b.txt`)).status).toBe(404);
  } finally {
    await device.stop();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("files rejects bad names and files over its limit", async () => {
  const { device, url, baseDir } = await open(100);
  try {
    for (const bad of [".hidden", "a%20b", "a%2Fb", "x".repeat(101)]) {
      expect((await fetch(`${url}/files/${bad}`, { method: "PUT", body: "x" })).status).toBe(400);
    }
    expect((await fetch(`${url}/files/${"x".repeat(100)}`, { method: "PUT", body: "x" })).status).toBe(201);
    const big = await fetch(`${url}/files/big`, { method: "PUT", body: new Uint8Array(101) });
    expect(big.status).toBe(413);
    expect((await fetch(`${url}/files/big`)).status).toBe(404);
    // A chunked upload, whose size isn't declared.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(60));
        c.enqueue(new Uint8Array(60));
        c.close();
      },
    });
    const chunked = await fetch(`${url}/files/chunked`, { method: "PUT", body: stream });
    expect(chunked.status).toBe(413);
    expect((await fetch(`${url}/files/chunked`)).status).toBe(404);
  } finally {
    await device.stop();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("files keeps its files over a cold swap", async () => {
  const { device, url, baseDir } = await open();
  try {
    await fetch(`${url}/files/keep`, { method: "PUT", body: "kept" });
    await device.swap();
    expect(await (await fetch(`${url}/files/keep`)).text()).toBe("kept");
  } finally {
    await device.stop();
    await rm(baseDir, { recursive: true, force: true });
  }
});
