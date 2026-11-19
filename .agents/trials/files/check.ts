// Starts the app on a free port and checks it from outside, over HTTP.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RackHandle } from "rack42u";
import { start } from "rack42u";

const MiB = 1024 * 1024;
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures.push(what);
    console.error(`FAIL ${what}`);
  } else {
    console.log(`ok   ${what}`);
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function bytesOf(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = x >> 16;
  }
  return bytes;
}

const dir = await mkdtemp(join(tmpdir(), "files-check-"));
const port = await freePort();
process.env.PORT = String(port);
process.env.FILES_DIR = dir;
const base = `http://127.0.0.1:${port}`;
const here = import.meta.dir;
const variants: string[] = [];

const { default: manifest } = await import("./rack.ts");
let running: RackHandle | undefined;

async function boot(): Promise<RackHandle> {
  return start(manifest, { baseDir: here, logger: () => {} });
}

async function put(name: string, body: BodyInit | null): Promise<Response> {
  return fetch(`${base}/files/${name}`, { method: "PUT", body });
}

async function roundTrip(name: string, bytes: Uint8Array): Promise<void> {
  const res = await put(name, bytes);
  const answer = (await res.json()) as { name: string; size: number; sha256: string };
  check(res.status === 201, `${name}: PUT answers 201 (got ${res.status})`);
  check(
    answer.name === name && answer.size === bytes.byteLength && answer.sha256 === sha256(bytes),
    `${name}: PUT answers name, size, and sha256`,
  );
  const got = await fetch(`${base}/files/${name}`);
  check(got.status === 200, `${name}: GET answers 200`);
  check(
    got.headers.get("content-length") === String(bytes.byteLength),
    `${name}: GET has Content-Length ${bytes.byteLength} (got ${got.headers.get("content-length")})`,
  );
  const back = new Uint8Array(await got.arrayBuffer());
  check(back.byteLength === bytes.byteLength && sha256(back) === sha256(bytes), `${name}: same size and hash`);
}

/** Changes a device's file, and replaces the device with it while the rack runs. */
async function change(device: string): Promise<void> {
  const file = join(here, "devices", `${device}.ts`);
  const copy = join(here, "devices", `${device}.changed.ts`);
  variants.push(copy);
  await writeFile(copy, `${await readFile(file, "utf8")}\nglobalThis.__changed = "${device}";\n`);
  const before = running!.status().find((s) => s.name === device)?.firmware;
  await running!.swap(device, copy);
  const slot = running!.status().find((s) => s.name === device);
  check(slot?.state === "online" && slot.firmware !== before, `${device}: changed while running, online`);
}

try {
  running = await boot();

  // Sizes
  await roundTrip("small.bin", bytesOf(1024, 1));
  await roundTrip("ten.bin", bytesOf(10 * MiB, 2));
  await roundTrip("max.bin", bytesOf(50 * MiB, 3));

  // Replacing
  const second = bytesOf(2048, 4);
  await roundTrip("small.bin", second);

  // Too large, declared and chunked
  const tooBig = bytesOf(50 * MiB + 1, 5);
  const declared = await put("big-declared.bin", tooBig).catch(() => null);
  check(declared?.status === 413, `declared upload over 50 MiB gets 413 (got ${declared?.status})`);
  let sent = 0;
  const chunked = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= tooBig.byteLength) return controller.close();
      const piece = tooBig.subarray(sent, Math.min(sent + MiB, tooBig.byteLength));
      sent += piece.byteLength;
      controller.enqueue(piece);
    },
  });
  const unknown = await fetch(`${base}/files/big-chunked.bin`, {
    method: "PUT",
    body: chunked,
    duplex: "half",
  } as RequestInit).catch(() => null);
  check(unknown?.status === 413, `chunked upload over 50 MiB gets 413 (got ${unknown?.status})`);
  const listing0 = (await (await fetch(`${base}/files`)).json()) as { name: string }[];
  check(!listing0.some((f) => f.name.startsWith("big-")), "no file left by an upload over 50 MiB");
  check((await readdir(dir)).every((n) => !n.startsWith(".tmp-")), "no temporary file left");
  check((await fetch(`${base}/files/big-declared.bin`)).status === 404, "the refused file is unknown");

  // Empty file, unknown name
  const empty = await put("empty", null);
  check(empty.status === 201 && ((await empty.json()) as any).size === 0, "an empty file is stored");
  check((await fetch(`${base}/files/nope`)).status === 404, "GET of an unknown name gets 404");

  // List and delete
  const listing = (await (await fetch(`${base}/files`)).json()) as {
    name: string;
    size: number;
    sha256: string;
  }[];
  const names = listing.map((f) => f.name);
  check(
    JSON.stringify(names) === JSON.stringify(["empty", "max.bin", "small.bin", "ten.bin"]),
    `list is sorted: ${names.join(",")}`,
  );
  check(
    listing.find((f) => f.name === "small.bin")?.sha256 === sha256(second) &&
      listing.find((f) => f.name === "small.bin")?.size === 2048,
    "list has size and sha256",
  );
  check((await fetch(`${base}/files/empty`, { method: "DELETE" })).status === 204, "DELETE answers 204");
  check((await fetch(`${base}/files/empty`, { method: "DELETE" })).status === 404, "DELETE again gets 404");
  check((await fetch(`${base}/files/empty`)).status === 404, "a deleted file is gone");

  // Names
  const bad = [".hidden", "a%2Fb", "a%20b", "x".repeat(101), "ü", "a*b", "..a"];
  for (const name of bad) {
    const res = await put(name, "x");
    check(res.status === 400, `name ${JSON.stringify(name.slice(0, 20))} gets 400 (got ${res.status})`);
  }
  const edge = await put("x".repeat(100), "x");
  check(edge.status === 201, "a name of 100 characters is fine");
  const dots = await put("a.b-c_D.1", "x");
  check(dots.status === 201, "dots, dashes, and underscores are fine");
  check((await fetch(`${base}/files/.hidden`)).status === 400, "GET of a bad name gets 400");
  check((await fetch(`${base}/files/x`, { method: "DELETE" })).status === 404, "DELETE of an unknown name gets 404");

  // Restart of the app
  await running.stop();
  running = await boot();
  const afterRestart = (await (await fetch(`${base}/files`)).json()) as { name: string; sha256: string }[];
  check(afterRestart.some((f) => f.name === "max.bin"), "files survive a restart");
  const max = await (await fetch(`${base}/files/max.bin`)).arrayBuffer();
  check(sha256(new Uint8Array(max)) === sha256(bytesOf(50 * MiB, 3)), "a file has its hash after a restart");

  // Change of the devices while the app runs
  await change("store");
  await roundTrip("after-store.bin", bytesOf(3 * MiB, 6));
  check((await running.status()).find((s) => s.name === "store") !== undefined, "store reports status");
  const modes = running.history("store").map((h) => h.mode);
  check(modes[0] === "cold", `the change of the writer is a cold swap (got ${modes[0]})`);
  const old = await fetch(`${base}/files/max.bin`);
  check(old.status === 200 && (await old.arrayBuffer()).byteLength === 50 * MiB, "older files are still served");
  await change("web");
  await roundTrip("after-web.bin", bytesOf(1 * MiB, 7));
} catch (error) {
  failures.push(`check crashed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
  console.error(error);
} finally {
  await running?.stop().catch(() => {});
  for (const file of variants) await rm(file, { force: true });
  await rm(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
