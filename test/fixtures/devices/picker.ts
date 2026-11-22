import { device, patched } from "racku";
import * as v from "valibot";
import { Picker, Probe } from "../connectors.ts";

const Config = v.optional(
  v.object({
    /** One need per name. */
    targets: v.optional(v.array(v.string()), []),
    /** Wire each need to `<name>.probe` with patched(), or leave the wiring to the rack. */
    wire: v.optional(v.boolean(), true),
    /** Throw from the needs function. */
    fail: v.optional(v.boolean(), false),
    /** Return something that isn't needs. */
    bad: v.optional(v.boolean(), false),
  }),
  {},
);

/** A device whose needs come from its configuration: one Probe need per target. */
export default device({
  model: "picker",
  config: Config,
  needs(config) {
    if (config.fail) throw new Error("no needs today");
    // Not needs: the rack checks what the function returns.
    if (config.bad) return { x: 42 } as never;
    return Object.fromEntries(
      config.targets.map((target) => [
        target,
        config.wire ? patched(Probe, `${target}.probe`) : Probe,
      ]),
    );
  },
  provides: { picker: Picker },
  powerOn: (ctx) => ({
    picker: {
      async names() {
        const names: Record<string, string> = {};
        for (const [need, port] of Object.entries(ctx.ports)) {
          names[need] = (await port.info(undefined)).name;
        }
        return names;
      },
    },
  }),
});
