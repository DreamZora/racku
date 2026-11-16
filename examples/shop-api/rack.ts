/**
 * The shop-api rack: SQLite storage at the bottom, an in-memory cache above it, and the orders
 * API on top, reachable over HTTP at /api/*.
 *
 * Run it from the repository root with `bun src/cli.ts start examples/shop-api/rack.ts`, or with
 * `dev` instead of `start` to hot-reload devices as you edit them. Set PORT to change the port.
 */
import { rack, slot } from "rack42u";
import { memkv, sqlite } from "rack42u/std";

export default rack("shop", {
  slots: {
    1: sqlite({ path: "data/shop.db" }),
    3: memkv(),
    5: slot("./devices/orders.ts", { config: { currency: "USD" } }),
  },
  // Only one kv/v1 provider exists, so this patch is optional; it shows the syntax.
  patch: [["orders.cache", "memkv.kv"]],
  panel: {
    http: {
      port: Number(process.env.PORT ?? 3000),
      routes: { "/api/*": "orders.http" },
    },
  },
});
