import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Sql } from "rack42u/std";
import { Codes, Store } from "../connectors.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

test("codes makes 6 letters and digits", async () => {
  await using codes = await bench(new URL("./codes.ts", import.meta.url), { needs: {} });
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const code = await codes.call("codes", "make", undefined);
    expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
    seen.add(code as string);
  }
  expect(seen.size).toBeGreaterThan(1);
});

test("store keeps links, refuses a taken code, counts visits", async () => {
  const rows = new Map<string, { url: string; visits: number }>();
  await using store = await bench(new URL("./store.ts", import.meta.url), {
    needs: {
      db: stub(Sql, {
        run({ sql, params }) {
          const p = params ?? [];
          if (sql.startsWith("INSERT")) {
            if (rows.has(String(p[0]))) return { changes: 0, lastInsertRowid: 0 };
            rows.set(String(p[0]), { url: String(p[1]), visits: 0 });
            return { changes: 1, lastInsertRowid: 1 };
          }
          if (sql.startsWith("UPDATE")) {
            const row = rows.get(String(p[0]));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.visits++;
            return { changes: 1, lastInsertRowid: 0 };
          }
          return { changes: 0, lastInsertRowid: 0 };
        },
        query({ sql, params }) {
          const code = String(params?.[0]);
          const row = rows.get(code);
          if (!row) return [];
          return sql.includes("visits") ? [{ code, ...row }] : [{ url: row.url }];
        },
      }),
    },
  });
  expect(await store.call("store", "create", { code: "abc123", url: "https://a.test/" })).toBe(true);
  expect(await store.call("store", "create", { code: "abc123", url: "https://b.test/" })).toBe(false);
  expect(await store.call("store", "visit", "abc123")).toBe("https://a.test/");
  expect(await store.call("store", "visit", "nope")).toBeNull();
  expect(await store.call("store", "get", "abc123")).toEqual({ code: "abc123", url: "https://a.test/", visits: 1 });
  expect(await store.call("store", "get", "nope")).toBeNull();
});

async function web(links: Map<string, { url: string; visits: number }>, codes: string[]) {
  return bench(new URL("./web.ts", import.meta.url), {
    needs: {
      store: stub(Store, {
        create({ code, url }) {
          if (links.has(code)) return false;
          links.set(code, { url, visits: 0 });
          return true;
        },
        get: (code) => (links.has(code) ? { code, ...links.get(code)! } : null),
        visit(code) {
          const l = links.get(code);
          if (!l) return null;
          l.visits++;
          return l.url;
        },
      }),
      codes: stub(Codes, { make: () => codes.shift() ?? "zzzzzz" }),
    },
  });
}

async function req(b: Awaited<ReturnType<typeof web>>, method: string, path: string, body?: string) {
  const res = (await b.call("http", "handle", {
    method,
    url: `http://localhost${path}`,
    headers: body === undefined ? [] : [["content-type", "application/json"]],
    params: {},
    body: body === undefined ? null : enc.encode(body),
  })) as { status: number; headers: [string, string][]; body: Uint8Array | null };
  return { ...res, text: res.body ? dec.decode(res.body) : "" };
}

test("web creates, validates, redirects, and reports links", async () => {
  const links = new Map<string, { url: string; visits: number }>();
  await using b = await web(links, ["aaaaaa", "aaaaaa", "bbbbbb"]);
  const ok = await req(b, "POST", "/links", JSON.stringify({ url: "https://example.com/x" }));
  expect(ok.status).toBe(201);
  expect(JSON.parse(ok.text)).toEqual({ code: "aaaaaa", url: "https://example.com/x" });
  // the second code is taken: the device asks again
  const again = await req(b, "POST", "/links", JSON.stringify({ url: "http://example.com/y" }));
  expect(JSON.parse(again.text).code).toBe("bbbbbb");

  for (const bad of ["not json", JSON.stringify({}), JSON.stringify({ url: "ftp://x.test/" }), JSON.stringify({ url: "/rel" })]) {
    const r = await req(b, "POST", "/links", bad);
    expect(r.status).toBe(400);
    expect(typeof JSON.parse(r.text).error).toBe("string");
  }

  const redirect = await req(b, "GET", "/aaaaaa");
  expect(redirect.status).toBe(302);
  expect(redirect.headers.find(([n]) => n.toLowerCase() === "location")?.[1]).toBe("https://example.com/x");
  expect((await req(b, "GET", "/unknown")).status).toBe(404);

  const info = await req(b, "GET", "/links/aaaaaa");
  expect(JSON.parse(info.text)).toEqual({ code: "aaaaaa", url: "https://example.com/x", visits: 1 });
  expect((await req(b, "GET", "/links/unknown")).status).toBe(404);
});
