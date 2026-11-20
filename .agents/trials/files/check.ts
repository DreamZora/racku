// Starts the app with `rack start` on a free port, and checks it through HTTP.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const appDir = import.meta.dir;
const MiB = 1024 * 1024;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
await probe.stop(true);
const base = `http://127.0.0.1:${port}`;

const stamp = `check-${Date.now()}`;
const work = join(appDir, "scratch", stamp);
const filesDir = join("scratch", stamp, "files"); // relative to the app
await mkdir(work, { recursive: true });

let child: Bun.Subprocess | undefined;
async function startApp() {
  child = Bun.spawn([join(appDir, "node_modules/.bin/rack"), "start"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), FILES_DIR: filesDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain output so the pipes never fill; keep the tail for failures.
  for (const stream of [child.stdout, child.stderr] as ReadableStream<Uint8Array>[]) {
    (async () => {
      for await (const chunk of stream) output = (output + new TextDecoder().decode(chunk)).slice(-4000);
    })();
  }
  await waitUp();
}
let output = "";

async function waitUp(timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/files`)).status === 200) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("the app didn't come up");
}

async function stopApp() {
  if (!child) return;
  child.kill("SIGINT");
  await child.exited;
  child = undefined;
}

function sha(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  return bytes;
}

async function roundTrip(name: string, bytes: Uint8Array) {
  const put = await fetch(`${base}/files/${name}`, { method: "PUT", body: bytes });
  check(put.status === 201, `PUT ${name}: status ${put.status}`);
  const body = (await put.json()) as { name: string; size: number; sha256: string };
  check(
    body.name === name && body.size === bytes.length && body.sha256 === sha(bytes),
    `PUT ${name}: body ${JSON.stringify(body)}`,
  );
  const got = await fetch(`${base}/files/${name}`);
  check(got.status === 200, `GET ${name}: status ${got.status}`);
  check(got.headers.get("content-length") === String(bytes.length), `GET ${name}: content-length`);
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of got.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    hasher.update(chunk);
  }
  check(size === bytes.length && hasher.digest("hex") === sha(bytes), `GET ${name}: size or hash differs`);
}

try {
  await startApp();

  await roundTrip("small.bin", payload(1024));
  await roundTrip("medium.bin", payload(10 * MiB));
  await roundTrip("large.bin", payload(50 * MiB));

  // Over the limit.
  const over = await fetch(`${base}/files/over.bin`, { method: "PUT", body: payload(50 * MiB + 1) }).catch(
    (error) => error as Error,
  );
  check(over instanceof Response && over.status === 413, `oversized PUT: ${over instanceof Response ? over.status : over}`);
  check((await fetch(`${base}/files/over.bin`)).status === 404, "oversized upload left a file");
  // A replaced file that is too large must stay as it was.
  const bigOverSmall = await fetch(`${base}/files/small.bin`, { method: "PUT", body: payload(50 * MiB + 1) }).catch(
    (error) => error as Error,
  );
  check(bigOverSmall instanceof Response && bigOverSmall.status === 413, "oversized replacement not 413");
  check((await (await fetch(`${base}/files/small.bin`)).arrayBuffer()).byteLength === 1024, "oversized replacement damaged the file");
  const leftovers = await readdir(join(appDir, filesDir)).catch(() => []);
  check(!leftovers.includes("over.bin"), "over.bin on disk");

  // List.
  const list = (await (await fetch(`${base}/files`)).json()) as { name: string; size: number; sha256: string }[];
  check(
    JSON.stringify(list.map((f) => [f.name, f.size])) ===
      JSON.stringify([["large.bin", 50 * MiB], ["medium.bin", 10 * MiB], ["small.bin", 1024]]),
    `list: ${JSON.stringify(list)}`,
  );

  // Names.
  for (const bad of [".hidden", "a%20b", "a%2Fb", "x".repeat(101), "a%00b"]) {
    const res = await fetch(`${base}/files/${bad}`, { method: "PUT", body: "x" });
    check(res.status === 400, `name ${bad}: status ${res.status}`);
    check((await fetch(`${base}/files/${bad}`)).status === 400, `GET name ${bad}: not 400`);
  }
  for (const good of ["a", "A.b-c_d", "x".repeat(100), "1"]) {
    const res = await fetch(`${base}/files/${good}`, { method: "PUT", body: "x" });
    check(res.status === 201, `name ${good}: status ${res.status}`);
    await fetch(`${base}/files/${good}`, { method: "DELETE" });
  }

  // Deletion.
  await fetch(`${base}/files/medium.bin`, { method: "DELETE" }).then((r) => check(r.status === 204, `DELETE: ${r.status}`));
  check((await fetch(`${base}/files/medium.bin`, { method: "DELETE" })).status === 404, "second DELETE not 404");
  check((await fetch(`${base}/files/medium.bin`)).status === 404, "GET after DELETE not 404");
  check((await fetch(`${base}/files/never`)).status === 404, "unknown GET not 404");
  await fetch(`${base}/files/large.bin`, { method: "DELETE" });

  // Restart.
  const before = await (await fetch(`${base}/files`)).text();
  await stopApp();
  await startApp();
  check((await (await fetch(`${base}/files`)).text()) === before, "the list changed over a restart");
  await roundTrip("after-restart.bin", payload(1 * MiB));
  const small = new Uint8Array(await (await fetch(`${base}/files/small.bin`)).arrayBuffer());
  check(small.length === 1024 && sha(small) === list.find((f) => f.name === "small.bin")?.sha256, "small.bin changed over a restart");

  // Change the device while the app runs.
  const source = await readFile(join(appDir, "devices/files.ts"), "utf8");
  await mkdir(join(appDir, "scratch/variant"), { recursive: true });
  await writeFile(join(appDir, "scratch/variant/files.ts"), `${source}\n// changed by check.ts\n`);
  const swap = Bun.spawn([join(appDir, "node_modules/.bin/rack"), "ctl", "swap", "files", "scratch/variant/files.ts"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const swapOut = (await new Response(swap.stdout).text()) + (await new Response(swap.stderr).text());
  check((await swap.exited) === 0, `rack ctl swap failed: ${swapOut}`);
  await waitUp();
  await roundTrip("after-swap.bin", payload(2 * MiB));
  const again = new Uint8Array(await (await fetch(`${base}/files/small.bin`)).arrayBuffer());
  check(again.length === 1024 && sha(again) === sha(small), "small.bin changed over the swap");
  const history = Bun.spawn([join(appDir, "node_modules/.bin/rack"), "ctl", "history", "files"], { cwd: appDir, stdout: "pipe" });
  const historyOut = await new Response(history.stdout).text();
  check(historyOut.includes("cold"), `the swap wasn't a cold one: ${historyOut.slice(0, 300)}`);
} catch (error) {
  failures.push(`error: ${error instanceof Error ? error.stack : error}`);
} finally {
  await stopApp();
  await rm(work, { recursive: true, force: true });
  await rm(join(appDir, "scratch/variant"), { recursive: true, force: true });
}

if (failures.length) {
  console.error("check failed:\n- " + failures.join("\n- "));
  if (output) console.error("--- app output (tail) ---\n" + output);
  process.exit(1);
}
console.log("check passed");
