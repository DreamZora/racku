import { type CallOptions, device, RackError } from "rack42u";
import { Probe, Relay } from "../connectors.ts";

const received: number[] = [];

type AnyMethod = (input: unknown, options?: CallOptions) => Promise<unknown>;

export default device({
  model: "relay",
  needs: { target: Probe },
  provides: { relay: Relay },
  powerOn(ctx) {
    ctx.on.target.pinged(({ n }) => {
      received.push(n);
    });
    return {
      relay: {
        async call({ member, input, timeout, cancelAfter }) {
          const controller = new AbortController();
          if (cancelAfter !== undefined) setTimeout(() => controller.abort(), cancelAfter);
          const method = (ctx.ports.target as unknown as Record<string, AnyMethod>)[member];
          try {
            if (method === undefined) throw new RackError("TEST_NO_MEMBER", member);
            const value = await method(input, { timeout, signal: controller.signal });
            return { ok: true, value };
          } catch (error) {
            const e = error as RackError;
            const instance = error instanceof RackError;
            return {
              ok: false,
              value: null,
              code: e.code,
              message: e.message,
              data: e.data,
              instance,
            };
          }
        },
        received: () => [...received],
      },
    };
  },
});
