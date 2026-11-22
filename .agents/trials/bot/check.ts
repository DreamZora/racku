import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const dir = import.meta.dir;
const plugins = join(dir, "plugins");

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const failures: string[] = [];
const created: string[] = [];
let log = "";

function expect(ok: boolean, what: string) {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
}

async function post(body: unknown, raw = false) {
  const res = await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const say = (text: string) => post({ user: "u", text });

async function until(what: string, fn: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) {
        expect(true, `${what} (${Date.now() - t0} ms)`);
        return;
      }
    } catch {}
    await Bun.sleep(100);
  }
  expect(false, `${what}: not within ${ms} ms`);
}

async function put(name: string, source: string) {
  created.push(name);
  await Bun.write(join(plugins, name), source);
}
async function drop(name: string) {
  await rm(join(plugins, name), { force: true });
}

const commandPlugin = (model: string, cmd: string, body: string) => `
import { device } from "racku";
import { Commands, commands } from "racku/std";
import * as v from "valibot";
export default device({
  model: "${model}",
  provides: { commands: Commands },
  powerOn: () => ({ commands: commands({ ${cmd}: { description: "${model} test", input: v.string(), run: async (arg) => { ${body} } } }) }),
});`;

const before = (await readdir(plugins)).sort();

const proc = Bun.spawn(["bun", "run", "start"], {
  cwd: dir,
  env: { ...process.env, PORT: String(port) },
  stdout: "pipe",
  stderr: "pipe",
});
for (const stream of [proc.stdout, proc.stderr]) {
  (async () => {
    for await (const chunk of stream) log += new TextDecoder().decode(chunk);
  })();
}

try {
  await until(
    "the bot starts",
    async () => (await fetch(`${base}/commands`)).status === 200 && (await (await fetch(`${base}/commands`)).json()).length >= 2,
    60_000,
  );

  // Commands
  const cmds = (await (await fetch(`${base}/commands`)).json()) as any[];
  const roll = cmds.find((c) => c.name === "roll");
  const time = cmds.find((c) => c.name === "time");
  expect(!!roll && roll.plugin === "dice" && typeof roll.description === "string", "GET /commands lists /roll with its plugin");
  expect(roll?.schema?.type === "string", "/roll has a JSON Schema for its argument");
  expect(!!time && time.plugin === "clock", "GET /commands lists /time");

  // Messages
  let r = await say("/roll 2d6");
  expect(r.status === 200 && /= \d+$/.test(r.body?.reply), "/roll 2d6 answers a reply");
  r = await say("/time Europe/Berlin");
  expect(r.status === 200 && /\d{2}:\d{2}:\d{2}/.test(r.body?.reply), "/time Europe/Berlin answers a time");
  r = await say("/nope x");
  expect(r.status === 404 && typeof r.body?.error === "string", "unknown command is 404");
  r = await say("hello");
  expect(r.status === 200 && r.body?.reply === null, "plain text answers null");
  r = await post("{not json", true);
  expect(r.status === 400 && typeof r.body?.error === "string", "non-JSON body is 400");
  r = await post({ user: 1, text: "x" });
  expect(r.status === 400, "non-string user is 400");
  r = await post({ user: "u", text: 5 });
  expect(r.status === 400, "non-string text is 400");
  r = await say("this is spam");
  expect(r.status === 403 && /spam/.test(r.body?.error), "the word filter refuses with 403 and a reason");

  // A new plugin
  await put("echo.ts", commandPlugin("echo", "echo", "return 'one:' + arg;"));
  await until("a new plugin's command works", async () => (await say("/echo hi")).body?.reply === "one:hi");
  const listed = (await (await fetch(`${base}/commands`)).json()) as any[];
  expect(listed.some((c) => c.name === "echo" && c.plugin === "echo"), "the new command is listed");

  // A changed plugin
  await put("echo.ts", commandPlugin("echo", "echo", "return 'two:' + arg;"));
  await until("a changed plugin's reply changes", async () => (await say("/echo hi")).body?.reply === "two:hi");

  // A syntax error
  await put("broken.ts", "export default device({ this is not ( valid");
  await Bun.sleep(3000);
  r = await say("/roll 1d6");
  expect(r.status === 200, "a plugin with a syntax error leaves the others working");
  expect((await say("/echo hi")).status === 200, "... also the plugin changed before");
  await until("the log names the broken plugin", async () => /broken/.test(log));
  await drop("broken.ts");

  // A crash
  await put("crash.ts", commandPlugin("crash", "boom", "throw new Error('kaboom');"));
  await until("a crashing command gets 500", async () => (await say("/boom x")).status === 500);
  expect((await say("/roll 1d6")).status === 200, "other plugins work after a crash");
  expect(/crash/.test(log) && /kaboom|boom/.test(log), "the log names the crashed plugin and why");

  // A hang
  await put("hang.ts", commandPlugin("hang", "stuck", "await new Promise(() => {}); return '';"));
  await until("the hanging plugin is plugged", async () => (await fetch(`${base}/commands`).then((x) => x.json())).some((c: any) => c.name === "stuck"));
  const t0 = Date.now();
  r = await say("/stuck x");
  const took = Date.now() - t0;
  expect(r.status === 504 && took < 10_000, `a hanging command gets 504 within 10 s (${took} ms)`);
  expect(/hang/.test(log), "the log names the hanging plugin");
  expect((await say("/roll 1d6")).status === 200, "other plugins work after a hang");

  // A filter that goes away
  await put(
    "nofoo.ts",
    `import { device } from "racku";
import { Filter } from "../connectors.ts";
export default device({ model: "nofoo", provides: { filter: Filter },
  powerOn: () => ({ filter: { check: ({ text }) => text.includes("foo") ? { ok: false, reason: "no foo here" } : { ok: true } } }) });`,
  );
  await until("a new filter refuses", async () => {
    const x = await say("a foo b");
    return x.status === 403 && x.body?.error === "no foo here";
  });
  await drop("nofoo.ts");
  await until("a removed filter no longer refuses", async () => (await say("a foo b")).status === 200);

  // Removing a command plugin
  await drop("echo.ts");
  await until("a removed plugin's command is gone", async () => (await say("/echo hi")).status === 404);
} catch (error) {
  failures.push(`check crashed: ${error}`);
  console.error(error);
} finally {
  for (const name of created) await drop(name);
  proc.kill("SIGINT");
  await Promise.race([proc.exited, Bun.sleep(10_000)]);
  proc.kill("SIGKILL");
  const after = (await readdir(plugins)).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) failures.push("plugins/ was not left as found");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n- ${failures.join("\n- ")}\n--- log ---\n${log.slice(-4000)}`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
