import { device } from "racku";
import * as v from "valibot";
import { Reports, type Result } from "../connectors.ts";

const FETCH_TIMEOUT = 10_000;

/** Fetches a URL once: its status and a hash of its body, or the error. */
export async function fetchOnce(url: string, timeout = FETCH_TIMEOUT): Promise<Result> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    const body = await response.arrayBuffer();
    return { status: response.status, hash: Bun.hash(body).toString(16) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export default device({
  model: "checker",
  needs: { reports: Reports },
  config: v.object({ url: v.string(), interval: v.number() }),

  activate(ctx, scope) {
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const result = await fetchOnce(ctx.config.url);
        await ctx.ports.reports.observe({
          url: ctx.config.url,
          at: new Date().toISOString(),
          result,
        });
      } catch (error) {
        ctx.log.warn("check failed", { error: String(error) });
      } finally {
        running = false;
      }
    };
    void check();
    scope.every(ctx.config.interval * 1000, check);
  },
});
