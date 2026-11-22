import { device } from "racku";
import * as v from "valibot";
import { Counter } from "../connectors.ts";

// Tests that exercise hot reload edit this line in a copy of the file.
const VERSION = "v1";

let n = 0;

export default device({
  model: "counter",
  provides: { counter: Counter },
  powerOn: (ctx) => ({
    counter: {
      inc: () => ++n,
      async slowInc(ms) {
        await Bun.sleep(ms);
        return ++n;
      },
      get: () => ({ n, firmware: ctx.firmware, version: VERSION }),
    },
  }),
  snapshot: () => ({ n }),
  restore(ctx, state) {
    const parsed = v.safeParse(v.object({ n: v.number() }), state);
    if (parsed.success) n = parsed.output.n;
    else ctx.log.warn("ignored an unknown snapshot");
  },
});
