/**
 * The device that the bench's tests run. It needs a key-value store and a blob store, carries its
 * count across hot swaps, records the keys its store reports changed, and serves its count over
 * HTTP when its configuration says so.
 *
 * @decision .agents/decisions/261118_173457-device-test-bench.md#tests
 */
import { device } from "rack42u";
import { Kv } from "rack42u/std";
import * as v from "valibot";
import { Blobs, Orders } from "../connectors.ts";

let count = 0;
const seen: string[] = [];

export default device({
  model: "orders",
  needs: { kv: Kv, blobs: Blobs },
  provides: { orders: Orders },
  config: v.object({ currency: v.string(), serve: v.optional(v.boolean(), false) }),

  async powerOn(ctx) {
    // In a hot swap the new instance isn't installed yet, so the rack drops this event; at a cold
    // start, nothing subscribes yet.
    await ctx.emit.orders.created({ id: "early" });
    ctx.on.kv.changed(({ key }) => {
      seen.push(key);
    });
    if (ctx.config.serve) {
      await ctx.serve({ port: 0, fetch: () => new Response(`${count} orders`) });
    }
    return {
      orders: {
        async create({ item, quantity }, call) {
          const id = String(++count);
          const order = JSON.stringify({ item, quantity, currency: ctx.config.currency });
          await ctx.ports.kv.set({ key: `order:${id}`, value: order }, { signal: call.signal });
          await ctx.emit.orders.created({ id });
          return { id };
        },
        count: () => count,
        find: (id, call) => ctx.ports.kv.get(`order:${id}`, { signal: call.signal }),
        put: ({ key, value }, call) =>
          ctx.ports.kv.set({ key, value: value as string }, { signal: call.signal }),
        seen: () => [...seen],
        upload: (input, call) => ctx.ports.blobs.put(input, { signal: call.signal }),
        download: (name, call) => ctx.ports.blobs.get(name, { signal: call.signal }),
        crash() {
          setTimeout(() => {
            throw new Error("orders crashed on purpose");
          });
        },
      },
    };
  },

  snapshot: () => ({ count }),
  restore(_ctx, state) {
    const parsed = v.safeParse(v.object({ count: v.number() }), state);
    if (parsed.success) count = parsed.output.count;
  },
});
