/**
 * Runs the app that the guides under docs/guides/ build, file by file, exactly as they show it, so
 * the guides and this test change together.
 *
 * @decision .agents/decisions/261112_043034-device-api.md
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type TempApp, tempApp } from "./fixtures/app.ts";

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
