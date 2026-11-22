import { device, type RackError } from "racku";
import { Busy, Client } from "../connectors.ts";

function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait on purpose: the Worker handles nothing else, not even the rack, until it ends.
  }
}

/** A consumer for race tests: calls the busy provider, blocks, or exits on demand. */
export default device({
  model: "client",
  needs: { busy: Busy },
  provides: { client: Client },
  powerOn: (ctx) => ({
    client: {
      async call({ timeout }) {
        try {
          return { ok: true, by: await ctx.ports.busy.whoami(undefined, { timeout }) };
        } catch (error) {
          return { ok: false, code: (error as RackError).code };
        }
      },
      spin: ({ ms }) => spin(ms),
      crash() {
        setTimeout(() => process.exit(3), 0);
      },
    },
  }),
});
