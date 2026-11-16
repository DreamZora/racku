/**
 * Runs the app that README.md builds section by section, exactly as the README shows it, so the
 * README and this test change together.
 *
 * @decision .agents/decisions/261112_043034-device-api.md
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT, type TempApp, tempApp } from "./fixtures/app.ts";

const README = await Bun.file(join(ROOT, "README.md")).text();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** The `ts` code blocks of the README, keyed by the path in their `// <path>` first line. */
function files(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [, code = ""] of README.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const path = /^\/\/ ([\w./-]+\.ts)\n/.exec(code)?.[1];
    if (path !== undefined) result.set(path, code);
  }
  return result;
}

/** The "From code" snippet: the block that imports the manifest and starts the rack. */
function program(): string {
  for (const [, code = ""] of README.matchAll(/```ts\n([\s\S]*?)```/g)) {
    if (code.includes('import manifest from "./rack.ts"')) return code;
  }
  throw new Error("README.md has no program that starts the rack");
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop();
  return port as number;
}

test("README.md: the hello app runs as written", async () => {
  const app = await tempApp();
  apps.push(app);
  const port = String(await freePort());
  const sources = files();
  expect([...sources.keys()].sort()).toEqual([
    "connectors.ts",
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
