/**
 * Builds the app of docs/getting-started.md as the guide says, outside this repository: rack42u
 * installed as a git dependency, from a repository that holds the files under test, the guide's
 * files, its commands, and the answers it shows. So the guide and this test change together.
 *
 * The install fetches valibot and @standard-schema/spec from the registry, into a cache of the
 * test's own, which goes with the test's directory.
 *
 * @decision .agents/decisions/261119_055008-documentation.md#tests-that-hold-the-documentation
 */
import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { headingAnchors, headingsOf } from "../scripts/markdown.ts";
import { ROOT } from "./fixtures/app.ts";
import { typecheck } from "./fixtures/typecheck.ts";

const GUIDE = await Bun.file(join(ROOT, "docs", "getting-started.md")).text();
const WORK = await mkdtemp(join(tmpdir(), "rack42u-start-"));
afterAll(async () => {
  await rm(WORK, { recursive: true, force: true });
});

/** The guide's code blocks in one language, in order. */
function blocks(language: string): string[] {
  const fence = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, "g");
  return [...GUIDE.matchAll(fence)].map((match) => match[1] ?? "");
}

/** The guide's command that starts with `prefix`. */
function command(prefix: string): string {
  const line = blocks("sh")
    .flatMap((block) => block.split("\n"))
    .find((text) => text.startsWith(prefix));
  if (line === undefined) throw new Error(`the guide has no command that starts with ${prefix}`);
  return line;
}

/** Runs a command to its end, and returns its exit code and output. */
async function exec(
  cmd: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; output: string }> {
  const run = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { code, stdout, output: stdout + stderr };
}

/** Copies the files under test into a new repository, and returns its URL and its commit. */
async function repository(): Promise<{ url: string; commit: string }> {
  const dir = join(WORK, "rack42u");
  const listed = await exec(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    ROOT,
  );
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    const source = Bun.file(join(ROOT, path));
    if (!(await source.exists())) continue; // deleted in the working tree
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await Bun.write(join(dir, path), source);
  }
  const git = (...args: string[]) =>
    exec(
      ["git", "-c", "user.name=rack42u test", "-c", "user.email=test@rack42u.invalid", ...args],
      dir,
    );
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "files under test"],
  ]) {
    const result = await git(...args);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.output}`);
  }
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  return { url: `git+${Bun.pathToFileURL(dir).href}`, commit };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Missing, or unreadable: either way, not there for the app.
    return false;
  }
}

/**
 * Reads a skill copied into an app, and follows the paths in the app that it names, such as
 * `node_modules/rack42u/docs/guides/devices.md#hooks`, and its relative links.
 *
 * @returns What it followed, and what led to no file, directory, or heading.
 */
async function follow(app: string, skill: string): Promise<{ followed: string[]; lost: string[] }> {
  const text = await Bun.file(skill).text();
  const targets = [
    ...[...text.matchAll(/`(node_modules\/rack42u\/[^`\s]*)`/g)].map(([, ref = ""]) => ({
      ref,
      base: app,
    })),
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(([, ref = ""]) => ({ ref, base: dirname(skill) }))
      .filter(({ ref }) => !/^[a-z][a-z0-9+.-]*:/i.test(ref)),
  ];
  const lost: string[] = [];
  for (const { ref, base } of targets) {
    const [path = "", anchor] = ref.split("#");
    const file = join(base, path);
    if (!(await exists(file))) lost.push(ref);
    else if (anchor !== undefined && file.endsWith(".md")) {
      const headings = headingsOf((await Bun.file(file).text()).split(/\r?\n/));
      if (!headingAnchors(headings).includes(anchor)) lost.push(ref);
    }
  }
  return { followed: targets.map(({ ref }) => ref), lost };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop();
  return port as number;
}

/** A `bun run` script of the app, running until its standard input closes. */
function script(name: string, cwd: string) {
  const run = Bun.spawn([process.execPath, "run", name, "--stop-on-stdin-close"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const decoder = new TextDecoder();
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const reading = Promise.all([read(run.stdout), read(run.stderr)]);
  return {
    get output() {
      return output;
    },
    async waitFor(pattern: RegExp, timeout = 30_000): Promise<void> {
      const until = Date.now() + timeout;
      while (!pattern.test(output)) {
        if (Date.now() > until) throw new Error(`no ${pattern} in:\n${output}`);
        if (run.exitCode !== null) throw new Error(`exited with ${run.exitCode}:\n${output}`);
        await Bun.sleep(20);
      }
    },
    /** Closes its standard input, which stops the rack in order, and returns the exit code. */
    async stop(): Promise<number> {
      run.stdin.end();
      const code = await run.exited;
      await reading;
      return code;
    },
  };
}

/** Runs each `curl` line of a block, and returns what came back next to what the guide shows. */
async function curls(block: string, port: number): Promise<{ got: string[]; shown: string[] }> {
  const got: string[] = [];
  const shown: string[] = [];
  const lines = block.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("curl ")) continue;
    const words = line.match(/'[^']*'|"[^"]*"|\S+/g)?.slice(1) ?? [];
    let method = "GET";
    let body: string | undefined;
    let url = "";
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      if (word === "-X") method = words[++i] as string;
      else if (word === "-d") body = (words[++i] as string).replace(/^'(.*)'$/, "$1");
      else url = word;
    }
    if (body !== undefined && method === "GET") method = "POST";
    const response = await fetch(`http://${url.replace("3000", String(port))}`, { method, body });
    got.push(await response.text());
    shown.push((lines[index + 1] ?? "").replace(/^# /, ""));
  }
  return { got, shown };
}

// @doc docs/getting-started.md
test("the app of the getting-started guide installs, runs, tests, and reloads as written", async () => {
  const app = join(WORK, "notes");
  await mkdir(app, { recursive: true });
  const [manifest] = blocks("json");
  expect(JSON.parse(manifest ?? "")).toMatchObject({
    name: "notes",
    scripts: { start: "rack start" },
  });
  await Bun.write(join(app, "package.json"), manifest ?? "");

  // Add rack42u as the guide does, from the repository of the files under test.
  const add = command("bun add ").split(" ");
  const shown = add.find((word) => word.startsWith("git+ssh://")) ?? "";
  expect(shown).toMatch(/^git\+ssh:\/\/git@github\.com\/DreamZora\/rack42u\.git#v\d+\.\d+\.\d+$/);
  const { url, commit } = await repository();
  const install = add.map((word) => (word === shown ? `${url}#${commit}` : word));
  const cache = join(WORK, "cache");
  const added = await exec(
    [process.execPath, ...install.slice(1), `--cache-dir=${cache}`, "--prefer-offline"],
    app,
  );
  expect({ code: added.code, output: added.code === 0 ? "" : added.output }).toEqual({
    code: 0,
    output: "",
  });

  // The skill that the guide copies into the app comes with the package, and once copied, what
  // it names leads to the documentation the app installed. The test copies as the command does,
  // since Bun's shell has no cp of its own on every system.
  expect(command("mkdir -p .claude/skills")).toBe(
    "mkdir -p .claude/skills && cp -r node_modules/rack42u/skills/rack42u .claude/skills/",
  );
  const skills = join(app, ".claude", "skills");
  await mkdir(skills, { recursive: true });
  await cp(join(app, "node_modules", "rack42u", "skills", "rack42u"), join(skills, "rack42u"), {
    recursive: true,
  });
  const skill = join(skills, "rack42u", "SKILL.md");
  expect(await Bun.file(skill).text()).toStartWith("---\nname: rack42u\n");
  const { followed, lost } = await follow(app, skill);
  expect(followed).toContain("node_modules/rack42u/docs/getting-started.md");
  expect(followed).toContain("node_modules/rack42u/docs/guides/devices.md#the-context");
  expect(lost).toEqual([]);

  const port = await freePort();
  const files = blocks("ts").filter((code) => /^\/\/ [\w./-]+\.ts\n/.test(code));
  expect(files.map((code) => code.split("\n")[0])).toEqual([
    "// connectors.ts",
    "// devices/notes.ts",
    "// devices/web.ts",
    "// rack.ts",
    "// devices/notes.test.ts",
  ]);
  for (const code of files) {
    const path = (code.split("\n")[0] as string).slice(3);
    await Bun.write(join(app, path), code.replaceAll("3000", String(port)));
  }

  const [running, reloaded] = blocks("sh").filter((block) => block.startsWith("curl "));
  expect(command("bun run ")).toBe("bun run start");

  const started = script("start", app);
  await started.waitFor(/rack notes started/);
  const first = await curls(running ?? "", port);
  expect(first.shown).toHaveLength(3);
  expect(first.got).toEqual(first.shown);
  expect(await started.stop()).toBe(0);

  expect(command("bun run test")).toBe("bun run test");
  const tested = await exec([process.execPath, "run", "test"], app);
  expect({ code: tested.code, output: tested.code === 0 ? "" : tested.output }).toEqual({
    code: 0,
    output: "",
  });
  expect(tested.output).toContain("1 pass");

  expect(command("bun run dev")).toBe("bun run dev");
  const dev = script("dev", app);
  await dev.waitFor(/watching /);
  const edit =
    blocks("ts")
      .find((code) => code.includes("ORDER BY id DESC"))
      ?.trim() ?? "";
  const source = await Bun.file(join(app, "devices", "notes.ts")).text();
  const old = source.split("\n").find((line) => line.trim().startsWith("const rows = ")) ?? "";
  await Bun.write(join(app, "devices", "notes.ts"), source.replace(old.trim(), edit));
  await dev.waitFor(/notes swapped/);
  const second = await curls(reloaded ?? "", port);
  expect(second.shown).toHaveLength(1);
  expect(second.got).toEqual(second.shown);
  expect(dev.output).not.toContain("web swapped");
  expect(await dev.stop()).toBe(0);
}, 120_000);

// @doc docs/getting-started.md
test("the files of the getting-started guide type-check", async () => {
  const files = new Map<string, string>();
  for (const code of blocks("ts")) {
    const path = /^\/\/ ([\w./-]+\.ts)\n/.exec(code)?.[1];
    if (path !== undefined) files.set(path, code);
  }
  expect([...files.keys()]).toHaveLength(5);
  expect(await typecheck(files)).toBe("");
}, 60_000);
