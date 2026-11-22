import { checkerName, launch } from "./app.ts";

const failures: string[] = [];
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failures.push(what);
};

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 20_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch {}
    await Bun.sleep(100);
  }
  failures.push(`timeout: ${what}`);
  console.log(`FAIL timeout: ${what}`);
  return undefined;
}

type Server = { url: string; hits: () => number; stop: () => void };
function serve(handler: (n: number) => Response | Promise<Response>): Server {
  let n = 0;
  const s = Bun.serve({ port: 0, fetch: () => handler(++n) });
  return { url: `http://127.0.0.1:${s.port}/`, hits: () => n, stop: () => void s.stop(true) };
}

const same = serve(() => new Response("always the same"));
const changing = serve((n) => new Response(`body ${n}`));
const failing = serve(() => new Response("broken", { status: 500 }));
const never = serve(() => new Promise<Response>(() => {}));
const added = serve(() => new Response("added later"));
const servers = [same, changing, failing, never, added];

const watchFile = `${import.meta.dir}/scratch/watch-check.json`;
const writeWatch = (urls: string[]) => Bun.write(watchFile, JSON.stringify({ interval: 1, urls }));
await writeWatch([same.url, changing.url, failing.url, never.url]);

const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
await probe.stop(true);

const app = await launch({
  watchFile,
  port,
  baseDir: import.meta.dir,
  logger: () => {},
  faultInjection: true,
  watchdog: 3000,
});
const api = (path: string) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json()) as Promise<any[]>;

try {
  // Reports of changes and failures.
  const events = await until("a report for each of the changing, failing, and silent URLs", async () => {
    const list = await api("/events");
    const has = (u: string) => list.some((e) => e.url === u);
    return has(changing.url) && has(failing.url) && has(never.url) ? list : undefined;
  }, 20_000);
  console.log("events:", JSON.stringify(events));
  const status = await until("a status for every URL", async () => {
    const list = await api("/status");
    return list.length === 4 ? list : undefined;
  });
  console.log("status:", JSON.stringify(status));
  ok(!events?.some((e) => e.url === same.url), "the steady URL reports nothing");
  const change = events?.find((e) => e.url === changing.url);
  ok(change?.from?.hash !== undefined && change?.to?.hash !== undefined && change.from.hash !== change.to.hash, "the changing URL reports from one body to another");
  ok(events?.find((e) => e.url === failing.url)?.to?.status === 500, "the failing URL reports its 500");
  ok(typeof events?.find((e) => e.url === never.url)?.to?.error === "string", "the silent URL reports a timeout error after 10 s");
  ok(status?.find((s) => s.url === same.url)?.status === 200 && typeof status?.[0]?.at === "string", "/status gives status and time");

  // A crash: the checker comes back and checks again.
  const grew = async (s: Server, since: number) => s.hits() > since;
  let before = same.hits();
  await app.running.injectFault(checkerName(same.url), "crash");
  await until("the crashed checker checks again", () => grew(same, before + 1));
  ok(app.running.status().find((s) => s.name === checkerName(same.url))?.state === "online", "the crashed checker is online again");

  // A hang: the others go on, and the hung one recovers within 30 s.
  const t0 = Date.now();
  before = same.hits();
  const otherBefore = changing.hits();
  await app.running.injectFault(checkerName(same.url), "hang");
  await until("another checker goes on during the hang", () => grew(changing, otherBefore + 2), 10_000);
  const mid = same.hits();
  await until("the hung checker checks again", () => grew(same, mid + 1), 30_000);
  ok(Date.now() - t0 < 30_000, `the hung checker recovered in ${Date.now() - t0} ms`);

  // A URL added while the app runs.
  const stable = app.running.status().find((s) => s.name === checkerName(changing.url))?.firmware;
  await writeWatch([same.url, changing.url, failing.url, never.url, added.url]);
  await until("the added URL is checked", () => added.hits() > 0);
  const list = await until("the added URL in /status", async () => {
    const l = await api("/status");
    return l.some((s) => s.url === added.url) ? l : undefined;
  });
  ok(!!list, "the added URL shows in /status");
  const names = app.running.status().map((s) => s.name);
  ok(names.includes(checkerName(added.url)) && names.includes(checkerName(same.url)), "the added URL has a checker of its own, the others stay");
  void stable;
} finally {
  await app.stop();
  for (const s of servers) s.stop();
}

if (failures.length) {
  console.log("failed:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("all checks passed");
process.exit(0);
