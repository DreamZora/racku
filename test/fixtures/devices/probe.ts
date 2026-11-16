import { device, RackError } from "rack42u";
import * as v from "valibot";
import { Probe } from "../connectors.ts";

// Lets a test prove that the rack main thread never evaluates device code.
(globalThis as { __rack42uDeviceLoaded?: boolean }).__rack42uDeviceLoaded = true;

const aborts: string[] = [];

export default device({
  model: "probe",
  provides: { probe: Probe },
  config: v.optional(
    v.object({ label: v.optional(v.string()), powerOnDelayMs: v.optional(v.number()) }),
  ),
  async powerOn(ctx) {
    if (ctx.config?.powerOnDelayMs !== undefined) await Bun.sleep(ctx.config.powerOnDelayMs);
    return {
      probe: {
        echo: (input) => input,
        fail({ code, message, data }) {
          if (code === undefined) throw new Error(message);
          throw new RackError(code, message, data);
        },
        wait: ({ ms }, call) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve("done"), ms);
            call.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const reason = call.signal.reason as { code?: string } | undefined;
                aborts.push(reason?.code ?? "unknown");
                reject(call.signal.reason);
              },
              { once: true },
            );
          }),
        aborts: () => [...aborts],
        info: () => ({
          name: ctx.slot.name,
          u: ctx.slot.u,
          firmware: ctx.firmware,
          baseDir: ctx.baseDir,
          env: process.env.RACK42U_TEST_ENV ?? null,
          config: ctx.config ?? null,
        }),
        // Deliberately violates the output schema.
        bad: () => 42 as unknown as string,
        double: (n) => n * 2,
        deadline: (_input, call) => call.deadline,
        async ping({ n }) {
          await ctx.emit.probe.pinged({ n });
        },
        async emitBad() {
          try {
            await ctx.emit.probe.pinged({ n: "not a number" as unknown as number });
            return "accepted";
          } catch (error) {
            return (error as RackError).code;
          }
        },
        crash(kind) {
          if (kind === "reject") void Promise.reject(new Error("rejected on purpose"));
          else if (kind === "throw") {
            setTimeout(() => {
              throw new Error("thrown on purpose");
            });
          } else process.exit(3);
        },
      },
    };
  },
});
