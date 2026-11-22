import { expect, test } from "bun:test";
import { RackError } from "racku";
import { bench, stub } from "racku/bench";
import { Codes, Links } from "../connectors.ts";

type Reply = { status: number; headers: [string, string][]; body: Uint8Array | null };

async function setup(taken: string[] = []) {
  const made: string[] = ["dup111", "new222"];
  const links = new Map<string, { url: string; visits: number }>(taken.map((c) => [c, { url: "https://x.example/", visits: 0 }]));
  const b = await bench(new URL("./api.ts", import.meta.url), {
    needs: {
      codes: stub(Codes, { make: () => made.shift() ?? "zzzzzz" }),
      links: stub(Links, {
        add({ code, url }) {
          if (links.has(code)) throw new RackError("LINK_TAKEN", "taken");
          links.set(code, { url, visits: 0 });
          return { code, url };
        },
        get: (code) => (links.has(code) ? { code, ...links.get(code)! } : null),
        visit(code) {
          const l = links.get(code);
          if (!l) return null;
          l.visits++;
          return l.url;
        },
      }),
    },
  });
  const req = async (method: string, path: string, body?: string): Promise<Reply> =>
    (await b.call("http", "handle", {
      method,
      url: `http://localhost${path}`,
      headers: [],
      params: {},
      body: body === undefined ? null : new TextEncoder().encode(body),
    })) as Reply;
  const text = (r: Reply) => (r.body ? new TextDecoder().decode(r.body) : "");
  return { b, req, text, links };
}

test("api creates links, retries a taken code, and validates", async () => {
  const { b, req, text } = await setup(["dup111"]);
  await using _ = b;
  const ok = await req("POST", "/links", JSON.stringify({ url: "https://example.com/p" }));
  expect(ok.status).toBe(201);
  expect(JSON.parse(text(ok))).toEqual({ code: "new222", url: "https://example.com/p" });
  for (const body of ["not json", JSON.stringify({ url: "ftp://x/" }), JSON.stringify({ url: "/rel" }), JSON.stringify({})]) {
    const r = await req("POST", "/links", body);
    expect(r.status).toBe(400);
    expect(typeof JSON.parse(text(r)).error).toBe("string");
  }
});

test("api redirects, counts, and answers 404", async () => {
  const { b, req, text } = await setup(["abc123"]);
  await using _ = b;
  const r = await req("GET", "/abc123");
  expect(r.status).toBe(302);
  expect(r.headers.find(([n]) => n.toLowerCase() === "location")?.[1]).toBe("https://x.example/");
  expect(JSON.parse(text(await req("GET", "/links/abc123")))).toEqual({ code: "abc123", url: "https://x.example/", visits: 1 });
  expect((await req("GET", "/nope00")).status).toBe(404);
  expect((await req("GET", "/links/nope00")).status).toBe(404);
});
