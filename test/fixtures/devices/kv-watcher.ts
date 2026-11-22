import { device } from "racku";
import { Kv } from "racku/std";
import * as v from "valibot";
import { Watcher } from "../connectors.ts";

const changes: string[] = [];

/** Subscribes to `kv/v1` change events and records their keys. */
export default device({
  model: "watcher",
  needs: { kv: Kv },
  provides: { watcher: Watcher },
  /** `throwOn`: a key whose change event makes the handler throw. */
  config: v.optional(v.object({ throwOn: v.optional(v.string()) }), {}),
  powerOn(ctx) {
    ctx.on.kv.changed(({ key }) => {
      if (key === ctx.config.throwOn) throw new Error(`handler failed on ${key}`);
      changes.push(key);
    });
    return { watcher: { changes: () => [...changes] } };
  },
});
