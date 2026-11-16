import { device } from "rack42u";
import { Counter, Probe, Pump } from "../connectors.ts";

/** Calls a probe and a counter below it when asked to. */
export default device({
  model: "pump",
  needs: { probe: Probe, counter: Counter },
  provides: { pump: Pump },
  powerOn(ctx) {
    const arrivals: number[] = [];
    ctx.on.probe.pinged(() => {
      arrivals.push(Date.now());
    });
    return {
      pump: {
        async burst({ n }) {
          const startedAt = Date.now();
          for (let i = 0; i < n; i++) await ctx.ports.probe.echo(i);
          return { startedAt, finishedAt: Date.now() };
        },
        async incs({ n, gapMs }) {
          const calls: Promise<{ value: number; ms: number }>[] = [];
          for (let i = 0; i < n; i++) {
            const started = performance.now();
            calls.push(
              ctx.ports.counter
                .inc(undefined)
                .then((value) => ({ value, ms: performance.now() - started })),
            );
            await Bun.sleep(gapMs);
          }
          const results = await Promise.all(calls);
          return {
            values: results.map((result) => result.value),
            maxMs: Math.max(...results.map((result) => result.ms)),
          };
        },
        pings: () => [...arrivals],
        spin({ ms }) {
          const until = Date.now() + ms;
          while (Date.now() < until) {
            // Busy-wait on purpose: the Worker answers nothing, not even metrics, until it ends.
          }
        },
      },
    };
  },
});
