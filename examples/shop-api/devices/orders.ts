/**
 * The orders device: a small JSON API over HTTP.
 *
 * It stores orders through `sql/v1`, caches them through `kv/v1`, and counts the requests it has
 * served; the count moves to the new instance when the device is hot-reloaded.
 */
import { device } from "rack42u";
import { Http, httpHandler, Kv, Sql } from "rack42u/std";
import * as v from "valibot";

const NewOrder = v.object({
  item: v.pipe(v.string(), v.minLength(1)),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
  price: v.pipe(v.number(), v.minValue(0)),
});

const ORDER_COLUMNS = "id, item, quantity, price";

// Requests served by this device, carried across hot reloads by snapshot and restore.
let served = 0;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export default device({
  model: "orders",
  height: 2,
  needs: { db: Sql, cache: Kv },
  provides: { http: Http },
  config: v.object({ currency: v.string() }),

  async powerOn(ctx) {
    const { db, cache } = ctx.ports;
    await db.run({
      sql: `CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        item TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    });

    return {
      http: httpHandler(async (request) => {
        served++;
        const { pathname } = new URL(request.url);
        const byId = /^\/api\/orders\/(\d+)$/.exec(pathname);

        if (request.method === "GET" && pathname === "/api/orders") {
          const orders = await db.query({ sql: `SELECT ${ORDER_COLUMNS} FROM orders ORDER BY id` });
          return json(200, { currency: ctx.config.currency, orders });
        }

        if (request.method === "POST" && pathname === "/api/orders") {
          const parsed = v.safeParse(NewOrder, await request.json().catch(() => null));
          if (!parsed.success) return json(400, { error: v.summarize(parsed.issues) });
          const { item, quantity, price } = parsed.output;
          const { lastInsertRowid } = await db.run({
            sql: "INSERT INTO orders (item, quantity, price, created_at) VALUES (?, ?, ?, ?)",
            params: [item, quantity, price, Date.now()],
          });
          const order = { id: Number(lastInsertRowid), item, quantity, price };
          await cache.set({ key: `order:${order.id}`, value: JSON.stringify(order) });
          return json(201, order);
        }

        if (request.method === "GET" && byId !== null) {
          const id = Number(byId[1]);
          const cached = await cache.get(`order:${id}`);
          if (cached !== null) return json(200, { ...JSON.parse(cached), cached: true });
          const [order] = await db.query({
            sql: `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`,
            params: [id],
          });
          if (order === undefined) return json(404, { error: `no order ${id}` });
          await cache.set({ key: `order:${id}`, value: JSON.stringify(order) });
          return json(200, { ...order, cached: false });
        }

        if (request.method === "GET" && pathname === "/api/stats") {
          return json(200, { served, firmware: ctx.firmware });
        }

        return json(404, { error: "not found" });
      }),
    };
  },

  // Background tasks start here, never in powerOn, so old and new instances never both run them.
  activate(ctx, scope) {
    scope.every(60_000, async () => {
      const [row] = await ctx.ports.db.query({ sql: "SELECT COUNT(*) AS count FROM orders" });
      ctx.log.info("orders stored", row);
    });
  },

  snapshot: () => ({ served }),

  restore(ctx, state) {
    const parsed = v.safeParse(v.object({ served: v.number() }), state);
    if (parsed.success) served = parsed.output.served;
    else ctx.log.warn("ignored a snapshot in an unknown format");
  },
});
