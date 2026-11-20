import { device } from "rack42u";
import { Sql } from "rack42u/std";
import { Store } from "../connectors.ts";

export default device({
  model: "links-store",
  needs: { db: Sql },
  provides: { store: Store },

  async powerOn(ctx) {
    await ctx.ports.db.run({
      sql: "CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, url TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0)",
    });
    return {
      store: {
        async create({ code, url }) {
          const { changes } = await ctx.ports.db.run({
            sql: "INSERT OR IGNORE INTO links (code, url) VALUES (?, ?)",
            params: [code, url],
          });
          return Number(changes) > 0;
        },
        async get(code) {
          const rows = await ctx.ports.db.query({
            sql: "SELECT code, url, visits FROM links WHERE code = ?",
            params: [code],
          });
          const row = rows[0];
          if (!row) return null;
          return { code: String(row.code), url: String(row.url), visits: Number(row.visits) };
        },
        async visit(code) {
          const { changes } = await ctx.ports.db.run({
            sql: "UPDATE links SET visits = visits + 1 WHERE code = ?",
            params: [code],
          });
          if (Number(changes) === 0) return null;
          const rows = await ctx.ports.db.query({ sql: "SELECT url FROM links WHERE code = ?", params: [code] });
          return rows[0] ? String(rows[0].url) : null;
        },
      },
    };
  },
});
