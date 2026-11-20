import { device } from "rack42u";
import * as v from "valibot";
import { Reports, Result } from "../connectors.ts";

const FETCH_TIMEOUT = 10_000;

const Config = v.object({ url: v.string(), interval: v.number() });

// The last result of this checker's URL; it reaches a new instance through snapshot and restore,
// and after a crash it comes back from the store.
let last: Result | null = null;

const same = (a: Result, b: Result) =>
  a.status === b.status && a.error === b.error && a.hash === b.hash;

/** Fetches one URL, and says what it came to. A fetch longer than 10 s is a failure. */
async function fetchResult(url: string, timeout = FETCH_TIMEOUT): Promise<Result> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "manual" });
    const body = await response.arrayBuffer();
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    return { status: response.status, error: null, hash };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    const code = (error as { code?: string })?.code;
    const message = name === "TimeoutError" || name === "AbortError" ? "timeout" : (code ?? name ?? "error");
    return { status: null, error: message, hash: null };
  }
}

/** Watches one URL, with state of its own. */
export default device({
  model: "checker",
  needs: { store: Reports },
  config: Config,

  activate(ctx, scope) {
    const { url, interval } = ctx.config;
    let busy = false;

    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await fetchResult(url);
        const at = new Date().toISOString();
        if (last === null) last = await ctx.ports.store.last(url);
        const change = last !== null && !same(last, result) ? { from: last, to: result } : null;
        await ctx.ports.store.record({ url, at, result, change });
        last = result;
      } catch (error) {
        ctx.log.warn("check failed", { url, error: String(error) });
      } finally {
        busy = false;
      }
    };

    void check();
    scope.every(interval * 1000, check);
  },

  snapshot: () => ({ last }),
  restore(_ctx, state) {
    const parsed = v.safeParse(v.object({ last: v.nullable(Result) }), state);
    if (parsed.success) last = parsed.output.last;
  },
});
