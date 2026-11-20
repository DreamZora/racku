/**
 * Runs the app that the guides under docs/guides/ build, file by file, exactly as they show it, so
 * the guides and this test change together.
 *
 * @decision .agents/decisions/261112_043034-device-api.md
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rack, slot, start } from "rack42u";
import { httpPanel } from "rack42u/std";
import { ROOT, type TempApp, tempApp, waitFor } from "./fixtures/app.ts";
import { typecheck } from "./fixtures/typecheck.ts";

/** The guides, in the order of their file names. */
const GUIDES = await Promise.all(
  [...new Bun.Glob("*.md").scanSync(join(ROOT, "docs", "guides"))].sort().map(async (name) => ({
    name,
    text: await Bun.file(join(ROOT, "docs", "guides", name)).text(),
  })),
);

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** The `ts` code blocks of the guides, keyed by the path in their `// <path>` first line. */
function files(): Map<string, string> {
  const result = new Map<string, string>();
  for (const { name, text } of GUIDES) {
    for (const [, code = ""] of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
      const path = /^\/\/ ([\w./-]+\.ts)\n/.exec(code)?.[1];
      if (path === undefined) continue;
      if (result.has(path))
        throw new Error(`${path} appears twice in the guides, again in ${name}`);
      result.set(path, code);
    }
  }
  return result;
}

/** The program of "Running a rack from code": the block that imports the manifest and starts it. */
function program(): string {
  for (const { text } of GUIDES) {
    for (const [, code = ""] of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
      if (code.includes('import manifest from "./rack.ts"')) return code;
    }
  }
  throw new Error("no guide has a program that starts the rack");
}

/** The program of "A layout that follows data", which reloads the rack with new manifests. */
function layoutProgram(): string {
  for (const { text } of GUIDES) {
    for (const [, code = ""] of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
      if (code.includes("function layout(")) return code;
    }
  }
  throw new Error("no guide has a program with a layout");
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop();
  return port as number;
}

// @doc docs/guides/connectors.md#defining-a-connector
// @doc docs/guides/devices.md#a-device-file
// @doc docs/guides/racks.md#placing-devices-by-hand
// @doc docs/guides/http.md#mounting-the-panel
// @doc docs/guides/running.md#running-a-rack-from-code
test("the greeter app of the guides runs as written", async () => {
  const app = await tempApp();
  apps.push(app);
  const port = String(await freePort());
  const sources = files();
  expect([...sources.keys()].sort()).toEqual([
    "connectors.ts",
    "devices/greeter.test.ts",
    "devices/greeter.ts",
    "devices/web.ts",
    "rack.ts",
  ]);
  for (const [path, code] of sources) await app.write(path, code.replaceAll("3000", port));

  // Each `await <expr>; // <expected>` line prints its value, to compare with the comment.
  const expected: string[] = [];
  const main = program()
    .replaceAll("3000", port)
    .split("\n")
    .map((line) => {
      const match = /^await (.+); \/\/ (".*")$/.exec(line);
      if (match === null) return line;
      expected.push(match[2] as string);
      return `console.log(JSON.stringify(await ${match[1]}));`;
    })
    .join("\n");
  expect(expected).toEqual(['"Hello, Ada"', '"Hello, Grace"']);
  await app.write("main.ts", main);

  const run = Bun.spawn([process.execPath, "main.ts"], {
    cwd: app.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  expect({ code, stderr: stderr.includes("error") ? stderr : "" }).toEqual({ code: 0, stderr: "" });
  const printed = stdout.split("\n").filter((line) => line.startsWith('"'));
  expect(printed).toEqual(expected);
});

// @decision .agents/decisions/261118_173457-device-test-bench.md#tests
// @doc docs/guides/testing.md#the-bench
test("the bench example of the guides tests the greeter as written", async () => {
  const app = await tempApp();
  apps.push(app);
  for (const [path, code] of files()) await app.write(path, code);
  const run = Bun.spawn([process.execPath, "test", "./devices/greeter.test.ts"], {
    cwd: app.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
  expect(stderr).toContain("1 pass");
  expect(existsSync(join(app.dir, ".rack", "bench"))).toBe(false);
});

// @doc docs/guides/running.md#running-a-rack-from-code
// @doc docs/guides/running.md#a-layout-that-follows-data
test("the greeter app of the guides type-checks", async () => {
  const sources = files();
  sources.set("main.ts", program());
  sources.set("layout.ts", layoutProgram());
  expect(await typecheck(sources)).toBe("");
}, 60_000);

// @doc docs/guides/running.md#a-layout-that-follows-data
test("the layout program of the running guide plugs and unplugs greeters as written", async () => {
  const app = await tempApp();
  apps.push(app);
  for (const [path, code] of files()) await app.write(path, code);
  // Each `<expression>; // <JSON>` line prints the expression's value, to compare with the JSON.
  const expected: unknown[] = [];
  const main = layoutProgram()
    .split("\n")
    .map((line) => {
      const match = /^(\S.*); \/\/ ([["].*)$/.exec(line);
      if (match === null) return line;
      expected.push(JSON.parse(match[2] as string));
      return `console.log(JSON.stringify(${match[1]}));`;
    })
    .join("\n");
  expect(expected).toHaveLength(4);
  await app.write("layout.ts", main);

  const run = Bun.spawn([process.execPath, "layout.ts"], {
    cwd: app.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  expect({ code, stderr: stderr.includes("error") ? stderr : "" }).toEqual({ code: 0, stderr: "" });
  const printed = stdout
    .split("\n")
    .filter((line) => /^[["]/.test(line) && !line.startsWith("[rack]"))
    .map((line) => JSON.parse(line) as unknown);
  expect(printed).toEqual(expected);
  // greeter-fr moved from U3 to U2 without a restart: it powered on once.
  expect(stdout.match(/greeter-fr powered on/g)).toHaveLength(1);
}, 60_000);

/** The greeter of "The context", whose helper takes a `DeviceContext`, as a whole device file. */
function typedGreeter(): string {
  const guide = GUIDES.find(({ name }) => name === "devices.md")?.text ?? "";
  const code = /```ts\n\/\/ In devices\/greeter\.ts:\n([\s\S]*?)```/.exec(guide)?.[1];
  if (code === undefined) throw new Error("the devices guide has no greeter with a typed helper");
  return [
    'import { type DeviceContext, device } from "rack42u";',
    'import { Kv } from "rack42u/std";',
    'import * as v from "valibot";',
    'import { Greeter } from "../connectors.ts";',
    "",
    code,
  ].join("\n");
}

// @doc docs/guides/devices.md#the-context
test("the greeter whose helper takes a DeviceContext type-checks", async () => {
  const sources = files();
  sources.set("devices/greeter.ts", typedGreeter());
  expect(await typecheck(sources)).toBe("");
}, 60_000);

/** The chat room of the HTTP panel guide, in a device file of its own. */
function chatRoom(): string {
  const guide = GUIDES.find(({ name }) => name === "http.md")?.text ?? "";
  const code = /```ts\n(powerOn\(ctx\) \{\n {2}const handler: HttpHandler[\s\S]*?)```/.exec(
    guide,
  )?.[1];
  if (code === undefined) throw new Error("the HTTP panel guide has no chat room");
  return [
    'import { device } from "rack42u";',
    'import { Http, type HttpHandler, httpHandler } from "rack42u/std";',
    "",
    'export default device({ model: "room", provides: { http: Http },',
    code,
    "});",
    "",
  ].join("\n");
}

/** A WebSocket client, once it is open, with the messages it got and the code it closed with. */
async function member(url: string) {
  const ws = new WebSocket(url);
  const messages: string[] = [];
  ws.addEventListener("message", (event) => messages.push(String(event.data)));
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code)),
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  /** Sends a message, and waits for it to come back, as every member of a room gets it. */
  const say = async (text: string) => {
    ws.send(text);
    await waitFor(() => messages.includes(text));
  };
  return { ws, messages, closed, say };
}

// @doc docs/guides/http.md#websocket
test("the chat room of the HTTP panel guide sends each message to the sender's room", async () => {
  expect(await typecheck(new Map([["devices/room.ts", chatRoom()]]))).toBe("");
  const app = await tempApp();
  apps.push(app);
  await app.write("devices/room.ts", chatRoom());
  const port = await freePort();
  const routes = { "/chat": "room.http" };
  const running = await start(
    rack("rooms", { slots: { 1: slot("./devices/room.ts"), 2: httpPanel({ port, routes }) } }),
    { baseDir: app.dir, logger: () => {} },
  );
  try {
    // Each member's own message comes back once the device knows the member.
    const ann = await member(`ws://127.0.0.1:${port}/chat?room=a`);
    await ann.say("ann is here");
    const bob = await member(`ws://127.0.0.1:${port}/chat?room=a`);
    await bob.say("bob is here");
    const cat = await member(`ws://127.0.0.1:${port}/chat`);
    await cat.say("cat is in the lobby");
    await ann.say("hello, room a");
    await waitFor(() => bob.messages.includes("hello, room a"));
    expect(ann.messages).toEqual(["ann is here", "bob is here", "hello, room a"]);
    expect(bob.messages).toEqual(["bob is here", "hello, room a"]);
    expect(cat.messages).toEqual(["cat is in the lobby"]);

    bob.ws.send(new Uint8Array([1, 2, 3]));
    expect(await bob.closed).toBe(1003);
    for (const { ws } of [ann, cat]) ws.close();
  } finally {
    await running.stop();
  }
}, 30_000);
