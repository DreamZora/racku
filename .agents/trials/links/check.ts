// Starts the app on a free port, goes through every behavior, restarts it, changes the code device while it runs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = import.meta.dir;
const codesFile = join(dir, "devices/codes.ts");
const originalCodes = await Bun.file(codesFile).text();
const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  void s.stop(true);
  return port;
};

const tmp = mkdtempSync(join(tmpdir(), "links-check-"));
const port = freePort();
const controlPort = freePort();
const token = "check-token";
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), LINKS_DB: join(tmp, "links.db"), RACK_CONTROL_TOKEN: token };

let proc: Bun.Subprocess | undefined;
const startApp = async () => {
  proc = Bun.spawn(["node_modules/.bin/rack","start", "--control-port", String(controlPort)], {
    cwd: dir, env, stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/links/nothere`);
      if (r.status === 404) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("the app did not come up");
};
const stopApp = async () => {
  if (!proc) return;
  proc.kill("SIGINT");
  await proc.exited;
  proc = undefined;
};
const post = (body: string) =>
  fetch(`${base}/links`, { method: "POST", body, headers: { "content-type": "application/json" } });
const make = async (url: string) => (await (await post(JSON.stringify({ url }))).json()) as { code: string; url: string };

try {
  await startApp();

  const r = await post(JSON.stringify({ url: "https://example.com/some/page" }));
  const created = (await r.json()) as { code: string; url: string };
  expect(r.status === 201, `POST /links: ${r.status}`);
  expect(/^[A-Za-z0-9]{6}$/.test(created.code), `code of 6 letters and digits: ${created.code}`);
  expect(created.url === "https://example.com/some/page", "created url");

  for (const bad of ["not json", "{}", JSON.stringify({ url: "/relative" }), JSON.stringify({ url: "ftp://x.org/f" }), JSON.stringify({ url: 5 }), "null"]) {
    const b = await post(bad);
    const body = (await b.json()) as { error?: string };
    expect(b.status === 400 && typeof body.error === "string", `400 with error for ${bad}: ${b.status}`);
  }

  const codes = new Set<string>([created.code]);
  for (let i = 0; i < 50; i++) codes.add((await make(`https://example.com/${i}`)).code);
  expect(codes.size === 51, "codes are unique");

  const info0 = await (await fetch(`${base}/links/${created.code}`)).json();
  expect(JSON.stringify(info0) === JSON.stringify({ code: created.code, url: created.url, visits: 0 }), `info before visits: ${JSON.stringify(info0)}`);
  for (let i = 0; i < 2; i++) {
    const g = await fetch(`${base}/${created.code}`, { redirect: "manual" });
    expect(g.status === 302 && g.headers.get("location") === created.url, `redirect: ${g.status} ${g.headers.get("location")}`);
  }
  const info = (await (await fetch(`${base}/links/${created.code}`)).json()) as { visits: number };
  expect(info.visits === 2, `visits counted: ${info.visits}`);
  expect((await fetch(`${base}/zzzzzz`, { redirect: "manual" })).status === 404, "unknown code 404");
  expect((await fetch(`${base}/links/zzzzzz`)).status === 404, "unknown info 404");

  // Restart.
  await stopApp();
  await startApp();
  const after = (await (await fetch(`${base}/links/${created.code}`)).json()) as { url: string; visits: number };
  expect(after.url === created.url && after.visits === 2, `survives restart: ${JSON.stringify(after)}`);
  expect((await fetch(`${base}/${created.code}`, { redirect: "manual" })).status === 302, "redirect after restart");

  // Change the code device while the app runs.
  const old = await make("https://example.com/old");
  expect(old.code.length === 6, "old code has 6 characters");
  await Bun.write(codesFile, originalCodes.replace("const LENGTH = 6;", "const LENGTH = 8;"));
  const reload = Bun.spawn(["node_modules/.bin/rack","ctl", "reload", "--url", `http://127.0.0.1:${controlPort}`, "--token", token], {
    cwd: dir, env, stdout: "pipe", stderr: "pipe",
  });
  const reloadOut = await new Response(reload.stdout).text();
  expect((await reload.exited) === 0, `rack ctl reload: ${reloadOut}`);
  const fresh = await make("https://example.com/new");
  expect(/^[A-Za-z0-9]{8}$/.test(fresh.code), `new link has 8 characters: ${fresh.code}`);
  expect((await fetch(`${base}/${old.code}`, { redirect: "manual" })).status === 302, "old link still redirects");
  expect((await fetch(`${base}/${fresh.code}`, { redirect: "manual" })).status === 302, "new link redirects");
} catch (error) {
  failures.push(`error: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await Bun.write(codesFile, originalCodes);
  await stopApp();
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("check passed");
