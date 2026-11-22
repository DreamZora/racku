import { device, RackError } from "racku";
import { Sql } from "racku/std";
import { Links } from "../connectors.ts";

export default device({
  model: "store",
  needs: { db: Sql },
  provides: { links: Links },

  async powerOn(ctx) {
    await ctx.ports.db.run({
      sql: "CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, url TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0)",
    });
    return {
      links: {
        async add({ code, url }) {
          try {
            await ctx.ports.db.run({ sql: "INSERT INTO links (code, url) VALUES (?, ?)", params: [code, url] });
          } catch (error) {
            const data = error instanceof RackError && error.code === "SQL_ERROR" ? error.data : undefined;
            const sqliteCode = (data as { code?: unknown } | undefined)?.code;
            if (typeof sqliteCode === "string" && sqliteCode.startsWith("SQLITE_CONSTRAINT")) {
              throw new RackError("LINK_TAKEN", `the code ${code} is taken`);
            }
            throw error;
          }
          return { code, url };
        },
        async get(code) {
          const rows = await ctx.ports.db.query({
            sql: "SELECT code, url, visits FROM links WHERE code = ?",
            params: [code],
          });
          const row = rows[0];
          return row ? { code: String(row.code), url: String(row.url), visits: Number(row.visits) } : null;
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
