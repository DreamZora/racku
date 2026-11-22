import { device } from "racku";
import * as v from "valibot";
import { Busy } from "../connectors.ts";

// Identifies the instance that answers, so tests can tell the old and the new instance apart.
const id = crypto.randomUUID();

function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait on purpose: the Worker handles nothing else until it ends.
  }
}

/**
 * A provider for race tests. `activateDelayMs` slows `activate` down. An instance whose Worker
 * starts while `RACKU_TEST_CRASH_AFTER_ACTIVATE_MS` is set exits that long after `activate`.
 */
export default device({
  model: "busy",
  provides: { busy: Busy },
  config: v.optional(v.object({ activateDelayMs: v.optional(v.number()) }), {}),
  powerOn: () => ({
    busy: {
      whoami: () => id,
      spin: ({ ms }) => spin(ms),
      crash() {
        setTimeout(() => process.exit(3), 0);
      },
    },
  }),
  async activate(ctx) {
    ctx.log.info("busy activating");
    if (ctx.config.activateDelayMs !== undefined) await Bun.sleep(ctx.config.activateDelayMs);
    const crashAfter = process.env.RACKU_TEST_CRASH_AFTER_ACTIVATE_MS;
    if (crashAfter !== undefined) setTimeout(() => process.exit(4), Number(crashAfter));
  },
});
