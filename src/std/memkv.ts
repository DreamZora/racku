/**
 * The `memkv` standard device: an in-memory `kv/v1` store.
 *
 * This file is device code and runs only in its Worker. It imports the framework through the
 * package name, so the firmware keeps the framework external instead of bundling a copy.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-devices
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 */
import { device } from "rack42u";
import { Kv } from "rack42u/std";
import * as v from "valibot";

const Entries = v.array(v.tuple([v.string(), v.string()]));

// One Worker per instance, so module state belongs to this instance alone.
let entries = new Map<string, string>();

export default device({
  model: "memkv",
  provides: { kv: Kv },
  powerOn(ctx) {
    return {
      kv: {
        get: (key) => entries.get(key) ?? null,
        async set({ key, value }) {
          entries.set(key, value);
          await ctx.emit.kv.changed({ key });
        },
        async delete(key) {
          const existed = entries.delete(key);
          if (existed) await ctx.emit.kv.changed({ key });
          return existed;
        },
        keys: (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
      },
    };
  },
  snapshot: () => [...entries],
  restore(ctx, state) {
    const parsed = v.safeParse(Entries, state);
    if (!parsed.success) {
      ctx.log.warn("ignored a snapshot in an unknown format");
      return;
    }
    entries = new Map(parsed.output);
  },
});
