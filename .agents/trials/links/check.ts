// Starts the app on a free port, goes through every behavior of SPEC.md, and stops it.
import { rm } from "node:fs/promises";

const dir = import.meta.dir;
const codesFile = `${dir}/devices/codes.ts`;
const originalCodes = await Bun.file(codesFile).text();
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
await probe.stop(true);
const base = `http://127.0.0.1:${port}`;

type App = { proc: Bun.Subprocess<"ignore", "pipe", "pipe">; log: () => string; waitFor: (text: string, from?: number) => Promise<void> };

function startApp(script: "start" | "dev"): App {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  for (const stream of [proc.stdout, proc.stderr]) {
    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) out += decoder.decode(chunk);
    })();
  }
  const waitFor = async (text: string, from = 0) => {
    const deadline = Date.now() + 60_000;
    while (!out.slice(from).includes(text)) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for "${text}"; log:\n${out}`);
      await Bun.sleep(50);
    }
  };
  return { proc, log: () => out, waitFor };
}

async function stopApp(app: App) {
  app.proc.kill("SIGINT");
  await app.proc.exited;
}

const post = (body: string) => fetch(`${base}/links`, { method: "POST", body, headers: { "content-type": "application/json" } });
const visit = (code: string) => fetch(`${base}/${code}`, { redirect: "manual" });
const info = async (code: string) => {
  const r = await fetch(`${base}/links/${code}`);
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

let app: App | undefined;
try {
  await rm(`${dir}/data`, { recursive: true, force: true });
  app = startApp("dev");
  await app.waitFor("rack links started");

  // creating
  const r1 = await post(JSON.stringify({ url: "https://example.com/some/page" }));
  check(r1.status === 201, `POST /links: 201, got ${r1.status}`);
  const l1 = (await r1.json()) as { code: string; url: string };
  check(/^[A-Za-z0-9]{6}$/.test(l1.code), `code of 6 letters and digits: ${l1.code}`);
  check(l1.url === "https://example.com/some/page", `url echoed: ${l1.url}`);
  const codes = new Set([l1.code]);
  for (let i = 0; i < 20; i++) codes.add(((await (await post(JSON.stringify({ url: `https://example.com/${i}` }))).json()) as { code: string }).code);
  check(codes.size === 21, "codes are unique");

  // bad bodies
  for (const bad of ["not json", "{}", JSON.stringify({ url: 5 }), JSON.stringify({ url: "ftp://x.test/f" }), JSON.stringify({ url: "/relative" }), JSON.stringify({ url: "javascript:alert(1)" })]) {
    const r = await post(bad);
    const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
    check(r.status === 400 && typeof body?.error === "string", `400 with error for ${bad}: ${r.status}`);
  }

  // redirecting and counting
  check((await info(l1.code)).body?.visits === 0, "no visits yet");
  for (let i = 0; i < 3; i++) {
    const r = await visit(l1.code);
    check(r.status === 302 && r.headers.get("location") === l1.url, `GET /<code>: 302 and Location, got ${r.status} ${r.headers.get("location")}`);
  }
  const i1 = await info(l1.code);
  check(i1.status === 200 && i1.body.code === l1.code && i1.body.url === l1.url && i1.body.visits === 3, `GET /links/<code>: ${JSON.stringify(i1)}`);
  check((await visit("nope00")).status === 404, "unknown code 404");
  check((await info("nope00")).status === 404, "unknown link info 404");

  // the change while the app runs: codes of 8 characters
  const mark = app.log().length;
  await Bun.write(codesFile, originalCodes.replace("const LENGTH = 6;", "const LENGTH = 8;"));
  await app.waitFor("link-codes swapped", mark);
  const r8 = await post(JSON.stringify({ url: "https://example.com/eight" }));
  const l8 = (await r8.json()) as { code: string; url: string };
  check(r8.status === 201 && /^[A-Za-z0-9]{8}$/.test(l8.code), `new link gets an 8-character code: ${l8.code}`);
  const old = await visit(l1.code);
  check(old.status === 302 && old.headers.get("location") === l1.url, "old link still redirects after the change");
  check((await visit(l8.code)).status === 302, "new link redirects");
  check((await info(l1.code)).body?.visits === 4, "old link's visits kept counting");
  await Bun.write(codesFile, originalCodes);
  await stopApp(app);

  // a restart keeps the links and their visits
  app = startApp("start");
  await app.waitFor("rack links started");
  const again = await info(l1.code);
  check(again.status === 200 && again.body.url === l1.url && again.body.visits === 4, `link survives restart: ${JSON.stringify(again)}`);
  check((await info(l8.code)).status === 200, "8-character link survives restart");
  const r6 = await post(JSON.stringify({ url: "https://example.com/after" }));
  check(/^[A-Za-z0-9]{6}$/.test(((await r6.json()) as { code: string }).code), "codes are 6 characters again once the file is restored");
  await stopApp(app);
  app = undefined;
} catch (error) {
  failures.push(String(error));
} finally {
  await Bun.write(codesFile, originalCodes);
  if (app) {
    app.proc.kill("SIGKILL");
  }
}

if (failures.length > 0) {
  console.error(`check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("check passed");
