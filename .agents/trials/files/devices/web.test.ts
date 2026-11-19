import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RackError } from "rack42u";
import { bench, stub } from "rack42u/bench";
import { Files } from "../connectors.ts";

const source = new URL("./web.ts", import.meta.url);

async function withWeb(
  maxSize: number,
  files: Parameters<typeof stub<typeof Files>>[1],
  run: (base: string, stubbed: { calls: { member: string; input: unknown }[] }) => Promise<void>,
) {
  const stubbed = stub(Files, files);
  await using web = await bench(source, { config: { port: 0, maxSize }, needs: { files: stubbed } });
  const url = web.rack.status().find((s) => s.name === "web")?.listeners?.[0]?.url;
  await run(String(url).replace(/\/$/, ""), stubbed);
}

test("web stores an upload, and answers its meta with 201", () =>
  withWeb(
    100,
    {
      async put({ name, bytes }) {
        let size = 0;
        for await (const chunk of bytes as ReadableStream<Uint8Array>) size += chunk.byteLength;
        return { name, size, sha256: "h" };
      },
    },
    async (base, stubbed) => {
      const res = await fetch(`${base}/files/a.txt`, { method: "PUT", body: "hello" });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ name: "a.txt", size: 5, sha256: "h" });
      expect(stubbed.calls[0]?.member).toBe("put");
    },
  ));

test("web answers 413 over its limit, from the length or from the store", () =>
  withWeb(
    5,
    {
      put() {
        throw new RackError("TOO_LARGE", "too large");
      },
    },
    async (base, stubbed) => {
      expect((await fetch(`${base}/files/a`, { method: "PUT", body: "123456789" })).status).toBe(413);
      expect(stubbed.calls.length).toBe(0); // refused by its length, the store never asked
      expect((await fetch(`${base}/files/a`, { method: "PUT", body: "123" })).status).toBe(413);
      expect(stubbed.calls.length).toBe(1);
    },
  ));

test("web serves a file with its Content-Length, and 404 for an unknown one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-test-"));
  const path = join(dir, "f");
  await writeFile(path, "0123456789");
  try {
    await withWeb(
      100,
      {
        locate: (name) => (name === "f" ? { path, size: 10, sha256: "h" } : null),
      },
      async (base) => {
        const res = await fetch(`${base}/files/f`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-length")).toBe("10");
        expect(await res.text()).toBe("0123456789");
        expect((await fetch(`${base}/files/g`)).status).toBe(404);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("web lists, deletes, and refuses bad names with 400", () =>
  withWeb(
    100,
    {
      list: () => [{ name: "a", size: 1, sha256: "h" }],
      remove: (name) => name === "a",
    },
    async (base, stubbed) => {
      expect(await (await fetch(`${base}/files`)).json()).toEqual([{ name: "a", size: 1, sha256: "h" }]);
      expect((await fetch(`${base}/files/a`, { method: "DELETE" })).status).toBe(204);
      expect((await fetch(`${base}/files/b`, { method: "DELETE" })).status).toBe(404);
      for (const name of [".hidden", "a%20b", "x".repeat(101), "%E4"]) {
        expect((await fetch(`${base}/files/${name}`)).status).toBe(400);
        expect((await fetch(`${base}/files/${name}`, { method: "PUT", body: "x" })).status).toBe(400);
      }
      expect(stubbed.calls.map((c) => c.member)).toEqual(["list", "remove", "remove"]);
    },
  ));
