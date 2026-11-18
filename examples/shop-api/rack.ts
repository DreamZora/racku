/**
 * The shop-api rack: SQLite storage at the bottom, an in-memory cache above it, the orders API
 * above that, and on top the HTTP panel, which passes requests for /api/* to the orders API.
 *
 * Run it from the repository root with `bun src/cli.ts start examples/shop-api/rack.ts`, or with
 * `dev` instead of `start` to hot-reload devices as you edit them. Set PORT to change the port.
 */
import { rack, slot } from "rack42u";
import { httpPanel, memkv, sqlite } from "rack42u/std";

export default rack("shop", {
  slots: {
    1: sqlite({ path: "data/shop.db" }),
    3: memkv(),
    5: slot("./devices/orders.ts", { config: { currency: "USD" } }),
    // The panel sits above the devices it routes to; orders occupies slots 5 and 6.
    7: httpPanel({ port: Number(process.env.PORT ?? 3000), routes: { "/api/*": "orders.http" } }),
  },
  // Only one kv/v1 provider exists, so this patch is optional; it shows the syntax.
  patch: [["orders.cache", "memkv.kv"]],
});
