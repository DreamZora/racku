import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./main.ts";

// The checkers' Workers copy process.env when they start, so set this first.
process.env.WATCHER_CHAOS = "1";

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(200);
  }
  expect(false, `${what} (timed out after ${ms} ms)`);
  return false;
}

// Test servers, on free ports.
let version = 1;
let flakyUp = true;
let chaosMode: "ok" | "hang" | "crash" = "ok";
let chaosHits = 0;
let changingHits = 0;
const servers = {
  same: Bun.serve({ port: 0, fetch: () => new Response("always the same") }),
  changing: Bun.serve({ port: 0, fetch: () => (changingHits++, new Response(`version ${version}`)) }),
  fail: Bun.serve({ port: 0, fetch: () => new Response("broken", { status: 500 }) }),
  never: Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) }),
  flaky: Bun.serve({ port: 0, fetch: () => new Response("flaky") }),
  chaos: Bun.serve({
    port: 0,
    fetch() {
      chaosHits++;
      const mode = chaosMode;
      chaosMode = "ok"; // misbehave once: a checker that fails again after every reset ends up faulted
      return new Response(mode === "ok" ? "calm" : `!${mode}`);
    },
  }),
  late: Bun.serve({ port: 0, fetch: () => new Response("added late") }),
};
const url = (name: keyof typeof servers) => `http://127.0.0.1:${servers[name].port}/`;
const flakyPort = servers.flaky.port;

const scratch = join(import.meta.dir, "scratch");
await mkdir(scratch, { recursive: true });
const dir = await mkdtemp(join(scratch, "check-"));
const watchFile = join(dir, "watch.json");
const write = (urls: string[]) => writeFile(watchFile, JSON.stringify({ interval: 1, urls }));
await write([url("same"), url("changing"), url("fail"), url("never"), url("flaky"), url("chaos")]);

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port as number;
probe.stop(true);

const app = await run({ watchFile, port, baseDir: import.meta.dir, pollMs: 300 });
const base = `http://127.0.0.1:${port}`;
const events = async (): Promise<any[]> => (await fetch(`${base}/events`)).json();
const status = async (): Promise<any[]> => (await fetch(`${base}/status`)).json();
const checkers = async () => (await app.running.status()).filter((s) => s.name.startsWith("checker"));
const statusOf = async (u: string) => (await status()).find((s) => s.url === u);

try {
  // Changes and failures.
  await until("every URL has a result", async () => (await status()).length >= 5, 20_000);
  expect((await statusOf(url("same")))?.result.status === 200, "/status: the steady URL answers 200");
  expect((await statusOf(url("fail")))?.result.status === 500, "/status: the failing URL answers 500");
  await until("the URL that never answers times out", async () => !!(await statusOf(url("never")))?.result.error, 25_000);
  expect(!!(await statusOf(url("never")))?.result.error, "/status: the URL that never answers is an error");

  version = 2;
  await until("the changing URL reports a new body", async () => (await events()).some((e) => e.url === url("changing")), 10_000);
  const change = (await events()).find((e) => e.url === url("changing"));
  expect(!!change && change.from.hash !== change.to.hash && typeof change.at === "number", "/events: a changed body is reported, with from, to, and at");

  servers.flaky.stop(true);
  await until("the stopped URL reports a failure", async () => (await events()).some((e) => e.url === `http://127.0.0.1:${flakyPort}/`), 10_000);
  const failure = (await events()).find((e) => e.url === `http://127.0.0.1:${flakyPort}/`);
  expect(!!failure?.from.status && !!failure?.to.error, "/events: success to failure is reported");
  void flakyUp;

  expect((await events()).every((e) => e.url !== url("same")), "no report for the steady URL");
  const list = await events();
  expect(list.every((e, i) => i === 0 || list[i - 1].at >= e.at), "/events: newest first");

  // A crash: the chaos server answers `!crash` once.
  chaosMode = "crash";
  const hitsBeforeCrash = chaosHits;
  await until("the crashed checker checks again", () => chaosHits > hitsBeforeCrash + 2, 15_000);
  expect((await checkers()).some((s) => s.crashes > 0), "a checker crashed");
  expect((await checkers()).every((s) => s.state === "online"), "every checker is online after the crash");

  // A hang: the checker's event loop blocks, and the watchdog resets it.
  const changingBefore = changingHits;
  const hitsBeforeHang = chaosHits;
  chaosMode = "hang";
  const hangStart = Date.now();
  await until("the hung checker is checking again", async () => chaosHits > hitsBeforeHang + 2, 30_000);
  const took = Date.now() - hangStart;
  expect(took < 30_000, `the hung checker recovered within 30 s (${took} ms)`);
  expect(changingHits > changingBefore + 3, "the other checkers went on checking meanwhile");

  // A URL added while the app runs.
  const before = (await checkers()).map((s) => `${s.name}:${s.firmware}`);
  const current = JSON.parse(await Bun.file(watchFile).text());
  await write([...current.urls, url("late")]);
  await until("the added URL gets checked", async () => !!(await statusOf(url("late"))), 15_000);
  expect((await statusOf(url("late")))?.result.status === 200, "a URL added to watch.json gets checked");
  const after = (await checkers()).map((s) => `${s.name}:${s.firmware}`);
  expect(before.every((b) => after.includes(b)), "the other checkers were not replaced");
} catch (error) {
  failures.push(`threw ${error}`);
  console.error(error);
} finally {
  await app.stop();
  for (const s of Object.values(servers)) s.stop(true);
  await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
