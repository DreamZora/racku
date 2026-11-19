import { expect, test } from "bun:test";
import { RackError } from "rack42u";
import { bench, stub } from "rack42u/bench";
import { Codes, Links } from "../connectors.ts";

const setup = () => {
  const made = ["aaaaaa", "aaaaaa", "bbbbbb"];
  const stored = new Map<string, { url: string; visits: number }>();
  const codes = stub(Codes, { make: () => made.shift() ?? "zzzzzz" });
  const links = stub(Links, {
    add({ code, url }) {
      if (stored.has(code)) throw new RackError("CODE_TAKEN", "taken");
      stored.set(code, { url, visits: 0 });
    },
    get: (code) => (stored.has(code) ? { code, ...stored.get(code)! } : null),
    visit(code) {
      const link = stored.get(code);
      if (!link) return null;
      link.visits++;
      return link.url;
    },
  });
  return { codes, links };
};

const request = (bt: Awaited<ReturnType<typeof bench>>, method: string, path: string, body?: string) =>
  bt.call("http", "handle", {
    method,
    url: `http://x${path}`,
    headers: [],
    params: {},
    body: body === undefined ? null : new TextEncoder().encode(body),
  }) as Promise<{ status: number; headers: [string, string][]; body: Uint8Array | null }>;
const text = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());

test("web creates, redirects, and reports links", async () => {
  await using web = await bench(new URL("./web.ts", import.meta.url), { needs: setup() });
  let r = await request(web, "POST", "/links", JSON.stringify({ url: "https://example.com/p" }));
  expect(r.status).toBe(201);
  expect(JSON.parse(text(r.body))).toEqual({ code: "aaaaaa", url: "https://example.com/p" });
  // The second code made is taken: web asks for another.
  r = await request(web, "POST", "/links", JSON.stringify({ url: "https://example.com/q" }));
  expect(JSON.parse(text(r.body)).code).toBe("bbbbbb");

  r = await request(web, "GET", "/aaaaaa");
  expect(r.status).toBe(302);
  expect(r.headers.find(([k]) => k.toLowerCase() === "location")?.[1]).toBe("https://example.com/p");
  r = await request(web, "GET", "/links/aaaaaa");
  expect(JSON.parse(text(r.body))).toEqual({ code: "aaaaaa", url: "https://example.com/p", visits: 1 });
  expect((await request(web, "GET", "/nope00")).status).toBe(404);
  expect((await request(web, "GET", "/links/nope00")).status).toBe(404);
});

test("web rejects bad bodies with 400", async () => {
  await using web = await bench(new URL("./web.ts", import.meta.url), { needs: setup() });
  for (const body of ["nope", "{}", '{"url":"/x"}', '{"url":"ftp://a/b"}']) {
    const r = await request(web, "POST", "/links", body);
    expect(r.status).toBe(400);
    expect(typeof JSON.parse(text(r.body)).error).toBe("string");
  }
});
