// Starts the app on a free port and checks the spec. Exit code 0, or 1 with what failed.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const appDir = import.meta.dir;
const dataDir = join(appDir, "scratch", `check-data-${process.pid}`);
const MiB = 1024 * 1024;
const failures: string[] = [];
const ok = (cond: unknown, what: string) => {
  if (!cond) {
    failures.push(what);
    console.error("FAIL:", what);
  } else console.log("ok:", what);
};

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port!;
  void s.stop(true);
  return port;
}

const port = freePort();
const base = `http://127.0.0.1:${port}`;
let child: Bun.Subprocess | undefined;

async function start() {
  child = Bun.spawn([join(appDir, "node_modules/.bin/rack"), "start"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), FILES_DIR: dataDir },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/files`);
      if (r.status === 200) return;
    } catch {}
    if (child.exitCode !== null) throw new Error("the app exited at start");
    await Bun.sleep(100);
  }
  throw new Error("the app did not come up");
}

async function stop() {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(15000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = undefined;
}

function payload(size: number): Uint8Array {
  const data = new Uint8Array(size);
  let x = 123456789;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    data[i] = x; data[i + 1] = x >>> 8; data[i + 2] = x >>> 16; data[i + 3] = x >>> 24;
  }
  return data;
}
const sha = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

async function roundTrip(name: string, data: Uint8Array) {
  const put = await fetch(`${base}/files/${name}`, { method: "PUT", body: data });
  ok(put.status === 201, `${name}: PUT answers 201 (got ${put.status})`);
  const info = (await put.json()) as { name: string; size: number; sha256: string };
  ok(info.name === name && info.size === data.byteLength && info.sha256 === sha(data), `${name}: PUT answers name, size, sha256`);
  const get = await fetch(`${base}/files/${name}`);
  ok(get.status === 200, `${name}: GET answers 200`);
  ok(get.headers.get("content-length") === String(data.byteLength), `${name}: GET has Content-Length ${data.byteLength}`);
  const back = new Uint8Array(await get.arrayBuffer());
  ok(back.byteLength === data.byteLength && sha(back) === sha(data), `${name}: download has the same size and hash`);
}

async function ctl(...args: string[]) {
  const p = Bun.spawn([join(appDir, "node_modules/.bin/rack"), "ctl", ...args], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), FILES_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: p.exitCode, out, err };
}

const storePath = join(appDir, "devices", "store.ts");
const storeSource = await Bun.file(storePath).text();

try {
  await rm(dataDir, { recursive: true, force: true });
  await start();

  await roundTrip("small.bin", payload(1024));
  await roundTrip("medium.bin", payload(10 * MiB));
  await roundTrip("large.bin", payload(50 * MiB));

  // Over the limit: declared length, and chunked.
  for (const [label, body] of [
    ["declared", payload(50 * MiB + 1)],
    [
      "chunked",
      new ReadableStream<Uint8Array>({
        start(c) {
          const data = payload(50 * MiB + 1);
          for (let o = 0; o < data.length; o += 1 * MiB) c.enqueue(data.subarray(o, o + 1 * MiB));
          c.close();
        },
      }),
    ],
  ] as const) {
    let status = 0;
    try {
      status = (await fetch(`${base}/files/over-${label}`, { method: "PUT", body, duplex: "half" } as RequestInit)).status;
    } catch (e) {
      status = -1;
      console.error(label, String(e));
    }
    ok(status === 413, `over 50 MiB (${label}) gets 413 (got ${status})`);
    ok((await fetch(`${base}/files/over-${label}`)).status === 404, `over 50 MiB (${label}) leaves no file`);
  }
  const leftovers = (await readdir(dataDir)).filter((n) => n.startsWith(".tmp-"));
  ok(leftovers.length === 0, "no temporary file stays behind");

  // List, replace, delete, names.
  await fetch(`${base}/files/b.txt`, { method: "PUT", body: "bb" });
  await fetch(`${base}/files/a.txt`, { method: "PUT", body: "a" });
  const replaced = await fetch(`${base}/files/a.txt`, { method: "PUT", body: "aaa" });
  ok(replaced.status === 201, "a file that exists is replaced");
  const list = (await (await fetch(`${base}/files`)).json()) as { name: string; size: number; sha256: string }[];
  const names = list.map((f) => f.name);
  ok(JSON.stringify(names) === JSON.stringify([...names].sort()), "the list is sorted by name");
  ok(list.find((f) => f.name === "a.txt")?.size === 3, "the list shows the replaced size");
  ok(list.find((f) => f.name === "a.txt")?.sha256 === sha(new TextEncoder().encode("aaa")), "the list shows sha256");
  ok((await fetch(`${base}/files/a.txt`, { method: "DELETE" })).status === 204, "DELETE answers 204");
  ok((await fetch(`${base}/files/a.txt`, { method: "DELETE" })).status === 404, "DELETE of an unknown name answers 404");
  ok((await fetch(`${base}/files/a.txt`)).status === 404, "GET of an unknown name answers 404");
  for (const bad of [".hidden", "a%2Fb", "a".repeat(101), "sp%20ace", "%C3%A9"]) {
    const status = (await fetch(`${base}/files/${bad}`, { method: "PUT", body: "x" })).status;
    ok(status === 400, `name ${bad.slice(0, 12)} gets 400 (got ${status})`);
  }
  ok((await fetch(`${base}/files/${"a".repeat(100)}`, { method: "PUT", body: "x" })).status === 201, "a name of 100 letters is accepted");
  ok((await fetch(`${base}/files/x`, { method: "PUT" })).status === 201, "an empty body stores an empty file");

  // A restart of the app.
  const before = await (await fetch(`${base}/files`)).text();
  await stop();
  await start();
  const after = await (await fetch(`${base}/files`)).text();
  ok(before === after && before.includes("large.bin"), "after a restart the files are still there");
  await roundTrip("after-restart.bin", payload(2 * MiB));

  // Change the device that writes files while the app runs.
  // A comment alone doesn't change the firmware: change the code.
  const marker = "const max = ctx.config.maxSize;";
  ok(storeSource.includes(marker), "check.ts finds its place to change in the store");
  await Bun.write(storePath, storeSource.replace(marker, `${marker} ctx.log.info("store changed", { at: ${Date.now()} });`));
  const reload = await ctl("reload");
  ok(reload.code === 0, `ctl reload succeeds (${reload.code} ${reload.err.trim()})`);
  console.log("reload output:", reload.out.slice(0, 600));
  const history = await ctl("history");
  ok(history.code === 0 && /"mode":\s*"cold"/.test(history.out), `the store was replaced by a cold swap (${history.out.slice(0, 400)} ${history.err})`);
  await roundTrip("after-change.bin", payload(3 * MiB));
  const listed = (await (await fetch(`${base}/files`)).json()) as { name: string }[];
  ok(listed.some((f) => f.name === "large.bin"), "files from before the change are still served");
} catch (e) {
  failures.push(`error: ${String(e)}`);
  console.error(e);
} finally {
  await Bun.write(storePath, storeSource);
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
