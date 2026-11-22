import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const rackBin = join(root, "node_modules/.bin/rack");
const failures: string[] = [];

function check(ok: boolean, what: string) {
  if (!ok) {
    failures.push(what);
    console.error("FAIL", what);
  } else console.log("ok  ", what);
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

type App = { proc: Bun.Subprocess; base: string; port: number; stop(): Promise<void> };

async function startApp(cmd: string[], cwd: string, base: string): Promise<App> {
  const port = freePort();
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain the output so the pipes never fill.
  let out = "";
  for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      for await (const chunk of stream) out += new TextDecoder().decode(chunk);
    })();
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`the app exited early:\n${out}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/links/nothere`);
      if (res.status === 404) break;
    } catch {}
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`the app did not come up:\n${out}`);
    }
    await Bun.sleep(100);
  }
  return {
    proc,
    base,
    port,
    async stop() {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(15_000).then(() => proc.kill("SIGKILL"))]);
    },
  };
}

const post = (app: App, body: string) =>
  fetch(`http://127.0.0.1:${app.port}/links`, { method: "POST", body, headers: { "content-type": "application/json" } });
const get = (app: App, path: string) => fetch(`http://127.0.0.1:${app.port}${path}`, { redirect: "manual" });

async function behaviors(app: App, label: string) {
  const url = `https://example.com/${label}/${crypto.randomUUID()}`;
  const created = await post(app, JSON.stringify({ url }));
  const link = (await created.json()) as { code: string; url: string };
  check(created.status === 201 && link.url === url && /^[A-Za-z0-9]{6}$/.test(link.code), `${label}: POST /links makes a 6 character code`);

  for (const [name, body] of [
    ["not JSON", "this is not json"],
    ["no url", "{}"],
    ["relative url", JSON.stringify({ url: "/a/b" })],
    ["ftp url", JSON.stringify({ url: "ftp://example.com/x" })],
    ["non-string url", JSON.stringify({ url: 5 })],
  ] as const) {
    const res = await post(app, body);
    const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
    check(res.status === 400 && typeof json?.error === "string", `${label}: 400 with an error for ${name}`);
  }

  const before = (await (await get(app, `/links/${link.code}`)).json()) as { visits: number };
  check(before.visits === 0, `${label}: a new link has 0 visits`);
  const hop = await get(app, `/${link.code}`);
  check(hop.status === 302 && hop.headers.get("location") === url, `${label}: GET /<code> redirects`);
  await get(app, `/${link.code}`);
  const info = await get(app, `/links/${link.code}`);
  check(
    info.status === 200 && JSON.stringify(await info.json()) === JSON.stringify({ code: link.code, url, visits: 2 }),
    `${label}: GET /links/<code> shows 2 visits`,
  );
  check((await get(app, "/zzzzzz")).status === 404, `${label}: unknown code redirects to 404`);
  check((await get(app, "/links/zzzzzz")).status === 404, `${label}: unknown link info is 404`);
  return link;
}

async function ctl(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${out}${err}`);
  return out;
}

async function codesVariant(): Promise<string> {
  const source = await Bun.file(join(root, "devices/codes.ts")).text();
  if (!source.includes("const LENGTH = 6;")) throw new Error("devices/codes.ts has no LENGTH = 6");
  return source.replace("const LENGTH = 6;", "const LENGTH = 8;");
}

async function changeWhileRunning(app: App, apply: () => Promise<void>, label: string, old: { code: string; url: string }) {
  await apply();
  let eight = false;
  let code = "";
  for (let i = 0; i < 100 && !eight; i++) {
    const res = await post(app, JSON.stringify({ url: `https://example.com/new/${crypto.randomUUID()}` }));
    code = ((await res.json()) as { code: string }).code;
    eight = /^[A-Za-z0-9]{8}$/.test(code);
    if (!eight) await Bun.sleep(100);
  }
  check(eight, `${label}: new links get 8 character codes (${code})`);
  const hop = await get(app, `/${old.code}`);
  check(hop.status === 302 && hop.headers.get("location") === old.url, `${label}: the old link still redirects`);
}

async function stopAndRestart(app: App, start: () => Promise<App>, link: { code: string; url: string }, label: string) {
  await app.stop();
  const again = await start();
  const info = (await (await get(again, `/links/${link.code}`)).json()) as { visits: number };
  check(info.visits === 2, `${label}: the link and its visits survive a restart`);
  const hop = await get(again, `/${link.code}`);
  check(hop.status === 302 && hop.headers.get("location") === link.url, `${label}: the link redirects after a restart`);
  return again;
}

async function main() {
  const original = await Bun.file(join(root, "devices/codes.ts")).text();
  const variant = await codesVariant();
  let app: App | undefined;
  try {
    // 1. The app from its sources.
    await rm(join(root, "data"), { recursive: true, force: true });
    const start = () => startApp([rackBin, "start"], root, root);
    app = await start();
    const link = await behaviors(app, "source");
    app = await stopAndRestart(app, start, link, "source");
    // The change while the app runs: rewrite the device file, then reload the rack.
    await changeWhileRunning(
      app,
      async () => {
        await Bun.write(join(root, "devices/codes.ts"), variant);
        await ctl([rackBin, "ctl", "reload"], root);
      },
      "source change",
      { code: link.code, url: link.url },
    );
    await app.stop();
    app = undefined;
    await Bun.write(join(root, "devices/codes.ts"), original);

    // 2. The executable.
    const dist = join(root, "dist");
    await rm(dist, { recursive: true, force: true });
    await ctl([rackBin, "compile", "rack.ts", "--outfile", "dist/links"], root);
    const exe = join(dist, "links");
    const startExe = () => startApp([exe], dist, dist);
    app = await startExe();
    const exeLink = await behaviors(app, "exe");
    app = await stopAndRestart(app, startExe, exeLink, "exe");
    await changeWhileRunning(
      app,
      async () => {
        await mkdir(join(dist, "devices"), { recursive: true });
        await Bun.write(join(dist, "connectors.ts"), await Bun.file(join(root, "connectors.ts")).text());
        await Bun.write(join(dist, "devices/codes.ts"), variant);
        await ctl([exe, "ctl", "reload"], dist);
      },
      "exe change",
      { code: exeLink.code, url: exeLink.url },
    );
  } catch (error) {
    failures.push(String(error instanceof Error ? error.stack : error));
    console.error(error);
  } finally {
    await app?.stop();
    await Bun.write(join(root, "devices/codes.ts"), original);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

await main();
