// Starts local HTTP servers and the app watching them, and shows what the app reports.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { checkerName, run } from "./watcher.ts";

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => Bun.sleep(ms);
async function until(what: string, condition: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(100);
  }
  expect(false, `${what} (within ${ms} ms)`);
  return false;
}

// The servers.
let changingBody = "first";
const same = Bun.serve({ port: 0, fetch: () => new Response("always the same") });
const changing = Bun.serve({ port: 0, fetch: () => new Response(changingBody) });
const flaky = Bun.serve({ port: 0, fetch: () => new Response("up") });
const flakyPort = flaky.port;
const never = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
const extra = Bun.serve({ port: 0, fetch: () => new Response("added later") });
const url = (s: { port?: number }) => `http://127.0.0.1:${s.port}/`;
const urls = { same: url(same), changing: url(changing), flaky: url(flaky), never: url(never), extra: url(extra) };

// The watch file lies in scratch/, which git ignores.
const dir = new URL("./scratch/check/", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = `${dir}watch.json`;
const write = (list: string[]) => writeFileSync(file, JSON.stringify({ interval: 1, urls: list }));
write([urls.same, urls.changing, urls.flaky, urls.never]);

const watcher = await run({ file, port: 0, faultInjection: true, logger: () => {} });
const panel = watcher.rack.status().find((d) => d.name === "http-panel")?.listeners?.[0]?.url;
if (!panel) throw new Error("the panel has no listener");
const getJson = async (path: string) => (await fetch(new URL(path, panel))).json() as Promise<any[]>;
const status = async (u: string) => (await getJson("/status")).find((s) => s.url === u);
const events = async (u?: string) => (await getJson("/events")).filter((e) => !u || e.url === u);

try {
  console.log(`panel at ${panel}`);

  // Every URL gets its first result.
  await until("every URL has a result", async () => (await getJson("/status")).length === 3, 5000);
  const s = await status(urls.same);
  expect(s?.result.status === 200 && typeof s.result.hash === "string", "/status shows the status code and a body hash");
  expect((await events()).length === 0, "no report while nothing changed");

  // A body that changes, a server that goes away and comes back.
  changingBody = "second";
  await until("a changed body is reported", async () => (await events(urls.changing)).length === 1, 5000);
  const change = (await events(urls.changing))[0];
  expect(change.from.hash !== change.to.hash && !!change.at && change.url === urls.changing, "the report has url, at, from, to");

  await flaky.stop(true);
  await until("a failure is reported", async () => (await events(urls.flaky)).length === 1, 5000);
  expect((await events(urls.flaky))[0].to.error !== null, "the failure carries its error");
  const back = Bun.serve({ port: flakyPort, fetch: () => new Response("up") });
  await until("a recovery is reported", async () => (await events(urls.flaky)).length === 2, 5000);
  expect((await events(urls.flaky))[0].to.status === 200, "reports come newest first, the recovery on top");
  await back.stop(true);

  // A server that never answers is a failure after 10 s, and the others go on meanwhile.
  await until("a server that never answers fails in 10 s", async () => (await status(urls.never))?.result.error === "timeout", 15000);
  expect((await status(urls.same)).at > s.at, "the other checkers went on checking meanwhile");

  // A checker that crashes recovers by itself.
  const crashing = checkerName(urls.same);
  const before = (await status(urls.same)).at;
  await watcher.rack.injectFault(crashing, "crash");
  await until("a crashed checker checks again", async () => (await status(urls.same)).at > before, 10000);
  expect(watcher.rack.status().find((d) => d.name === crashing)?.state === "online", "the crashed checker is online again");

  // A checker that hangs recovers within 30 s, and the others go on.
  const hanging = checkerName(urls.changing);
  const other = (await status(urls.same)).at;
  const hungAt = (await status(urls.changing)).at;
  const t0 = Date.now();
  await watcher.rack.injectFault(hanging, "hang");
  await until("the other checkers check during the hang", async () => (await status(urls.same)).at > other, 5000);
  const hungStill = (await status(urls.changing)).at === hungAt;
  expect(hungStill, "the hung checker has stopped checking");
  const recovered = await until("a hung checker checks again", async () => (await status(urls.changing)).at > hungAt, 30_000);
  if (recovered) {
    const took = Date.now() - t0;
    expect(took < 30_000, `the hung checker recovered in ${(took / 1000).toFixed(1)} s`);
  }

  // A URL added while the app runs gets a checker; the others keep running as they are.
  const firmware = (name: string) => watcher.rack.status().find((d) => d.name === name)?.firmware;
  const tracked = [urls.same, urls.changing, urls.flaky, urls.never].map(checkerName);
  const firmwares = tracked.map(firmware);
  const instances = watcher.rack.history().length;
  write([urls.same, urls.changing, urls.flaky, urls.never, urls.extra]);
  await until("a URL added to watch.json gets checked", async () => (await status(urls.extra))?.result.status === 200, 8000);
  expect(tracked.map(firmware).every((f, i) => f === firmwares[i]), "the other checkers kept their firmware");
  const records = watcher.rack.history().slice(0, watcher.rack.history().length - instances);
  if (records.length !== 1 || records[0]!.mode !== "plug") console.log("records:", JSON.stringify(records));
  expect(
    records.length === 1 && records[0]!.device === checkerName(urls.extra) && records[0]!.mode === "plug",
    "only the new checker was plugged",
  );
  console.log("reports:", JSON.stringify(await events()));
  console.log("status:", JSON.stringify(await getJson("/status")));
} catch (error) {
  expect(false, `the check threw: ${String(error)}`);
} finally {
  await watcher.stop();
  for (const server of [same, changing, never, extra]) await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall good");
process.exit(0);
