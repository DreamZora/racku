import { expect, test } from "bun:test";
import { RackError } from "rack42u";
import { bench, stub } from "rack42u/bench";
import { Sql } from "rack42u/std";

type Row = { code: string; url: string; visits: number };

const fakeDb = () => {
  const rows = new Map<string, Row>();
  const impl = stub(Sql, {
    run({ sql, params }) {
      const p = params ?? [];
      if (sql.startsWith("INSERT")) {
        if (rows.has(String(p[0]))) throw new RackError("SQL_ERROR", "unique", { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
        rows.set(String(p[0]), { code: String(p[0]), url: String(p[1]), visits: 0 });
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql.startsWith("UPDATE")) {
        const row = rows.get(String(p[0]));
        if (row) row.visits++;
        return { changes: row ? 1 : 0, lastInsertRowid: 0 };
      }
      return { changes: 0, lastInsertRowid: 0 };
    },
    query({ sql, params }) {
      const row = rows.get(String(params?.[0]));
      if (!row) return [];
      return [sql.includes("visits") ? row : { url: row.url }];
    },
  });
  return impl;
};

test("store adds, gets, and counts visits", async () => {
  await using store = await bench(new URL("./store.ts", import.meta.url), { needs: { db: fakeDb() } });
  await store.call("links", "add", { code: "abc123", url: "https://a.example/" });
  expect(await store.call("links", "get", "abc123")).toEqual({ code: "abc123", url: "https://a.example/", visits: 0 });
  expect(await store.call("links", "visit", "abc123")).toBe("https://a.example/");
  expect(await store.call("links", "get", "abc123")).toEqual({ code: "abc123", url: "https://a.example/", visits: 1 });
  expect(await store.call("links", "visit", "nope")).toBeNull();
  expect(await store.call("links", "get", "nope")).toBeNull();
});

test("store reports a taken code as CODE_TAKEN", async () => {
  await using store = await bench(new URL("./store.ts", import.meta.url), { needs: { db: fakeDb() } });
  await store.call("links", "add", { code: "abc123", url: "https://a.example/" });
  const error = await store.call("links", "add", { code: "abc123", url: "https://b.example/" }).catch((e: { code: string }) => e);
  expect((error as { code: string }).code).toBe("CODE_TAKEN");
});
