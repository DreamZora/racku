import { expect, test } from "bun:test";
import { RackError } from "racku";
import { bench, stub } from "racku/bench";
import { Sql } from "racku/std";

test("store adds, gets, and counts visits through its database", async () => {
  const rows = new Map<string, { url: string; visits: number }>();
  await using store = await bench(new URL("./store.ts", import.meta.url), {
    needs: {
      db: stub(Sql, {
        run({ sql, params }) {
          const p = params ?? [];
          if (sql.startsWith("INSERT")) {
            const code = String(p[0]);
            if (rows.has(code)) throw new RackError("SQL_ERROR", "unique", { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
            rows.set(code, { url: String(p[1]), visits: 0 });
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
          const code = String(params?.[0]);
          const row = rows.get(code);
          if (!row) return [];
          return sql.includes("visits") ? [{ code, ...row }] : [{ url: row.url }];
        },
      }),
    },
  });
  expect(await store.call("links", "add", { code: "abc123", url: "https://a.example/" })).toEqual({
    code: "abc123",
    url: "https://a.example/",
  });
  const taken = await store.call("links", "add", { code: "abc123", url: "https://b.example/" }, { timeout: 2000 }).catch((e) => e);
  expect((taken as RackError).code).toBe("LINK_TAKEN");
  expect(await store.call("links", "visit", "abc123")).toBe("https://a.example/");
  expect(await store.call("links", "visit", "nope00")).toBeNull();
  expect(await store.call("links", "get", "abc123")).toEqual({ code: "abc123", url: "https://a.example/", visits: 1 });
  expect(await store.call("links", "get", "nope00")).toBeNull();
});
