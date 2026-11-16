import { type DeviceLog, device } from "rack42u";
import * as v from "valibot";
import { Hook, Life } from "../connectors.ts";

const Config = v.optional(
  v.object({
    failAt: v.optional(Hook),
    hangAt: v.optional(Hook),
    /** Starts a `scope.every` timer that logs `tick`. */
    tickMs: v.optional(v.number()),
    /** Makes the timer task throw. */
    tickThrows: v.optional(v.boolean()),
    /** Makes the deactivate hook take this long. */
    slowDeactivateMs: v.optional(v.number()),
    /** Schedules `scope.after` timers: one that logs `after`, one cancelled at once. */
    afterMs: v.optional(v.number()),
  }),
  {},
);

interface StepContext {
  log: DeviceLog;
  config: v.InferOutput<typeof Config>;
}

// Identifies this instance in hook logs, so tests can tell the old and the new instance apart.
const instance = crypto.randomUUID();
let ticks = 0;

/** Logs the hook, then fails or hangs there when the config asks for it. */
async function step(ctx: StepContext, hook: v.InferOutput<typeof Hook>): Promise<void> {
  ctx.log.info("hook", { hook, instance });
  if (ctx.config.failAt === hook) throw new Error(`${hook} failed on purpose`);
  if (ctx.config.hangAt === hook) await new Promise(() => {});
}

export default device({
  model: "lifecycle",
  provides: { life: Life },
  config: Config,
  async powerOn(ctx) {
    await step(ctx, "powerOn");
    ctx.signal.addEventListener("abort", () => ctx.log.info("signal aborted", { instance }));
    return { life: { ticks: () => ticks } };
  },
  selfTest: (ctx) => step(ctx, "selfTest"),
  async activate(ctx, scope) {
    await step(ctx, "activate");
    scope.signal.addEventListener("abort", () => ctx.log.info("scope aborted", { instance }));
    const { tickMs, tickThrows, afterMs } = ctx.config;
    if (tickMs !== undefined) {
      scope.every(tickMs, () => {
        ticks++;
        ctx.log.debug("tick", { instance });
        if (tickThrows) throw new Error("tick failed on purpose");
      });
    }
    if (afterMs !== undefined) {
      scope.after(afterMs, () => ctx.log.info("after", { instance }));
      const cancel = scope.after(afterMs, () => ctx.log.info("cancelled timer ran", { instance }));
      cancel();
    }
  },
  async deactivate(ctx) {
    await step(ctx, "deactivate");
    if (ctx.config.slowDeactivateMs !== undefined) await Bun.sleep(ctx.config.slowDeactivateMs);
  },
  powerOff: (ctx) => step(ctx, "powerOff"),
});
