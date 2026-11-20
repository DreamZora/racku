import { device } from "rack42u";
import * as v from "valibot";
import { type Result, Watch } from "../connectors.ts";

const FETCH_TIMEOUT = 10_000;

const same = (a: Result, b: Result) => a.status === b.status && a.error === b.error && a.hash === b.hash;

async function fetchOnce(url: string): Promise<Result> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), redirect: "manual" });
    const body = await response.text();
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    return { status: response.status, hash, ...(chaos(body) ?? {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.name : String(error) };
  }
}

/**
 * With WATCHER_CHAOS set, a body of `!hang` or `!crash` makes the checker misbehave,
 * which is how check.ts causes a hang and a crash on purpose.
 */
function chaos(body: string): undefined {
  if (!process.env.WATCHER_CHAOS) return;
  if (body === "!hang") for (;;);
  if (body === "!crash") setTimeout(() => { throw new Error("chaos"); }, 0);
}

export default device({
  model: "checker",
  needs: { watch: Watch },
  config: v.object({ url: v.string(), interval: v.number() }),

  activate(ctx, scope) {
    let previous: Result | null = null;
    let busy = false;

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        // After a reset the checker starts empty, and asks the store what it saw last.
        previous ??= await ctx.ports.watch.last(ctx.config.url);
        const result = await fetchOnce(ctx.config.url);
        const from = previous && !same(previous, result) ? previous : undefined;
        previous = result;
        await ctx.ports.watch.record({ url: ctx.config.url, at: Date.now(), result, from });
      } catch (error) {
        ctx.log.warn("check failed", { error: String(error) });
      } finally {
        busy = false;
      }
    };

    void tick();
    scope.every(ctx.config.interval * 1000, tick);
  },
});
