/**
 * Builds the app of docs/getting-started.md as the guide says, outside this repository: racku
 * installed from the tarball that `bun pm pack` makes of the files under test, as npm is to get
 * it, in place of racku's repository at the tag the guide names, then the guide's files, its
 * commands, and the answers it shows. So the guide and this test change together. Another test
 * installs racku through git, at a tag and at a commit, from a repository of the files under test.
 *
 * The installs fetch valibot and @standard-schema/spec from the registry, into a cache of the
 * test's own, which goes with the test's directory.
 *
 * @decision .agents/decisions/261119_055008-documentation.md#tests-that-hold-the-documentation
 * @decision .agents/decisions/261122_005312-first-formal-release.md#before-100
 * @decision .agents/decisions/261123_020201-git-installs-until-npm.md#until-racku-is-on-npm
 */
import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { headingAnchors, headingsOf } from "../scripts/markdown.ts";
import { ROOT } from "./fixtures/app.ts";
import { typecheck, typecheckInstalled } from "./fixtures/typecheck.ts";

const GUIDE = await Bun.file(join(ROOT, "docs", "getting-started.md")).text();
/** The version under test, and the URL of racku's repository, which the guide's command names. */
const { version: VERSION, repository: REPOSITORY } = (await Bun.file(
  join(ROOT, "package.json"),
).json()) as { version: string; repository: { url: string } };
const WORK = await mkdtemp(join(tmpdir(), "racku-start-"));
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

/**
 * Copies the files under test into a new repository, with the tag of the version under test, and
 * returns its URL and its commit.
 */
async function repository(): Promise<{ url: string; commit: string }> {
  const dir = join(WORK, "racku");
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
      ["git", "-c", "user.name=racku test", "-c", "user.email=test@racku.invalid", ...args],
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
  // A tag of its own, unsigned whatever git's settings say.
  const tagged = await git("-c", "tag.gpgSign=false", "tag", `v${VERSION}`);
  if (tagged.code !== 0) throw new Error(`git tag failed: ${tagged.output}`);
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  return { url: `git+${Bun.pathToFileURL(dir).href}`, commit };
}

let packed: Promise<string> | undefined;

/** The tarball that `bun pm pack` makes of the files under test, made once for the tests. */
function tarball(): Promise<string> {
  packed ??= (async () => {
    const dir = join(WORK, "pack");
    await mkdir(dir, { recursive: true });
    const pack = await exec(
      [process.execPath, "pm", "pack", "--destination", dir, "--quiet"],
      ROOT,
    );
    const path = pack.stdout.trim();
    if (pack.code !== 0 || !(await Bun.file(path).exists())) {
      throw new Error(`bun pm pack failed: ${pack.output}`);
    }
    return path;
  })();
  return packed;
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
 * `node_modules/racku/docs/guides/devices.md#hooks`, and its relative links.
 *
 * @returns What it followed, and what led to no file, directory, or heading.
 */
async function follow(app: string, skill: string): Promise<{ followed: string[]; lost: string[] }> {
  const text = await Bun.file(skill).text();
  const targets = [
    ...[...text.matchAll(/`(node_modules\/racku\/[^`\s]*)`/g)].map(([, ref = ""]) => ({
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
// @doc docs/guides/running.md#running-a-rack-from-another-program
test("the app of the getting-started guide installs, runs, tests, and reloads as written", async () => {
  const app = join(WORK, "notes");
  await mkdir(app, { recursive: true });
  const [manifest] = blocks("json");
  expect(JSON.parse(manifest ?? "")).toMatchObject({
    name: "notes",
    scripts: { start: "rack start" },
  });
  await Bun.write(join(app, "package.json"), manifest ?? "");

  // Add racku as the guide does, through git at the tag of the version under test, here from the
  // tarball of the files under test, which npm is to get. A test below installs through git.
  const shown = `${REPOSITORY.url}#v${VERSION}`;
  expect(command("bun add ")).toBe(`bun add ${shown} valibot`);
  const install = command("bun add ")
    .split(" ")
    .map(async (word) => (word === shown ? await tarball() : word));
  const cache = join(WORK, "cache");
  const added = await exec(
    [
      process.execPath,
      ...(await Promise.all(install)).slice(1),
      `--cache-dir=${cache}`,
      "--prefer-offline",
    ],
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
    "mkdir -p .claude/skills && cp -r node_modules/racku/skills/racku .claude/skills/",
  );
  const skills = join(app, ".claude", "skills");
  await mkdir(skills, { recursive: true });
  await cp(join(app, "node_modules", "racku", "skills", "racku"), join(skills, "racku"), {
    recursive: true,
  });
  const skill = join(skills, "racku", "SKILL.md");
  expect(await Bun.file(skill).text()).toStartWith("---\nname: racku\n");
  // The skill adds racku with the guide's command.
  expect(await Bun.file(skill).text()).toContain(`\`${command("bun add ")}\``);
  const { followed, lost } = await follow(app, skill);
  expect(followed).toContain("node_modules/racku/docs/getting-started.md");
  expect(followed).toContain("node_modules/racku/docs/guides/devices.md#the-context");
  expect(lost).toEqual([]);

  const port = await freePort();
  const files = blocks("ts").filter((code) => /^\/\/ [\w./-]+\.ts\n/.test(code));
  expect(files.map((code) => code.split("\n")[0])).toEqual([
    "// connectors.ts",
    "// devices/notes.ts",
    "// devices/web.ts",
    "// rack.ts",
    "// test/notes.test.ts",
  ]);
  for (const code of files) {
    const path = (code.split("\n")[0] as string).slice(3);
    await Bun.write(join(app, path), code.replaceAll("3000", String(port)));
  }

  // `bun run rack` runs the manifest, rack.ts, and not the rack command, which would refuse
  // `status` with a usage error.
  const wrong = await exec([process.execPath, "run", "rack", "status"], app);
  expect({ code: wrong.code, output: wrong.output.trim() }).toEqual({ code: 0, output: "" });

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
  // The app type-checks with racku as installed, its sources included.
  expect(await typecheckInstalled(app)).toBe("");

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

test("the tarball of bun pm pack holds package.json and only what its files field names", async () => {
  const { files } = (await Bun.file(join(ROOT, "package.json")).json()) as { files: string[] };
  const archive = new Bun.Archive(await Bun.file(await tarball()).bytes());
  const entries = [...(await archive.files()).keys()];
  const under = (entry: string, name: string) =>
    entry === `package/${name}` || entry.startsWith(`package/${name}/`);
  expect(entries.filter((entry) => !files.some((name) => under(entry, name)))).toEqual([
    "package/package.json",
  ]);
  for (const name of files) expect(entries.some((entry) => under(entry, name))).toBe(true);
  // What the exports, the rack command, and the skill name.
  expect(entries).toEqual(
    expect.arrayContaining([
      "package/src/index.ts",
      "package/src/std/index.ts",
      "package/src/bench.ts",
      "package/src/cli.ts",
      "package/skills/racku/SKILL.md",
      "package/docs/getting-started.md",
    ]),
  );
}, 60_000);

// @doc docs/getting-started.md#add-racku
test("racku installs through git from its repository at a tag or a commit, which package.json keeps", async () => {
  const { url, commit } = await repository();
  for (const [name, ref] of [
    ["tag", `v${VERSION}`],
    ["commit", commit],
  ] as const) {
    const app = join(WORK, `from-git-${name}`);
    await mkdir(app, { recursive: true });
    await Bun.write(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
    const added = await exec(
      [
        process.execPath,
        "add",
        `${url}#${ref}`,
        `--cache-dir=${join(WORK, "cache")}`,
        "--prefer-offline",
      ],
      app,
    );
    expect({ name, code: added.code, output: added.code === 0 ? "" : added.output }).toEqual({
      name,
      code: 0,
      output: "",
    });
    expect((await Bun.file(join(app, "package.json")).json()).dependencies.racku).toBe(
      `${url}#${ref}`,
    );
    const imported = await exec(
      [process.execPath, "-e", 'const { rack } = await import("racku"); console.log(typeof rack);'],
      app,
    );
    expect({ name, imported: imported.stdout.trim() }).toEqual({ name, imported: "function" });
  }
}, 60_000);

// @doc docs/getting-started.md#add-racku
test("bun add, in a directory without a package.json, changes the nearest one above it", async () => {
  const outer = join(WORK, "outer");
  const app = join(outer, "app");
  const tiny = join(WORK, "tiny");
  await mkdir(app, { recursive: true });
  await mkdir(tiny, { recursive: true });
  await Bun.write(join(outer, "package.json"), JSON.stringify({ name: "outer", private: true }));
  await Bun.write(join(tiny, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0" }));

  const added = await exec(
    [process.execPath, "add", "../../tiny", `--cache-dir=${join(WORK, "cache")}`],
    app,
  );
  expect({ code: added.code, output: added.code === 0 ? "" : added.output }).toEqual({
    code: 0,
    output: "",
  });
  expect(added.output.toLowerCase()).not.toContain("warn");
  expect(await exists(join(app, "package.json"))).toBe(false);
  const changed = await Bun.file(join(outer, "package.json")).json();
  expect(Object.keys(changed.dependencies ?? {})).toEqual(["tiny"]);
}, 60_000);

// @doc docs/getting-started.md#add-racku
test("bun add keeps a branch or HEAD in package.json, and only bun.lock holds the commit", async () => {
  const dep = join(WORK, "pinned");
  await mkdir(dep, { recursive: true });
  await Bun.write(join(dep, "package.json"), JSON.stringify({ name: "pinned", version: "1.0.0" }));
  const git = async (...args: string[]) => {
    const result = await exec(
      ["git", "-c", "user.name=racku test", "-c", "user.email=test@racku.invalid", ...args],
      dep,
    );
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.output}`);
    return result.stdout.trim();
  };
  const commit = async (message: string) => {
    await git("add", "-A");
    await git("commit", "-q", "--no-verify", "--no-gpg-sign", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-q", "-b", "main");
  const first = await commit("first");
  const url = `git+${Bun.pathToFileURL(dep).href}`;
  const bun = (app: string, ...args: string[]) =>
    exec([process.execPath, ...args, `--cache-dir=${join(WORK, "cache")}`], app);
  const dependencyOf = async (app: string) =>
    (await Bun.file(join(app, "package.json")).json()).dependencies.pinned;
  const lockOf = (app: string) => Bun.file(join(app, "bun.lock")).text();

  for (const ref of ["main", "HEAD"]) {
    const app = join(WORK, `pin-${ref}`);
    await mkdir(app, { recursive: true });
    await Bun.write(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
    const added = await bun(app, "add", `${url}#${ref}`);
    expect({ code: added.code, output: added.code === 0 ? "" : added.output }).toEqual({
      code: 0,
      output: "",
    });
    // Bun reports the commit it installed, as installed pinned@git+file:///…#<commit>.
    expect(added.output).toMatch(new RegExp(`installed pinned@git\\+\\S+#${first}\\b`));
    expect(await dependencyOf(app)).toBe(`${url}#${ref}`);
    expect(await lockOf(app)).toContain(first);
  }

  // Once the branch moves on, an install with bun.lock keeps its commit, and a fresh one doesn't.
  await Bun.write(join(dep, "next.txt"), "next");
  const second = await commit("second");
  const app = join(WORK, "pin-HEAD");
  expect((await bun(app, "install")).code).toBe(0);
  expect(await lockOf(app)).toContain(first);
  await rm(join(app, "bun.lock"));
  await rm(join(app, "node_modules"), { recursive: true, force: true });
  expect((await bun(app, "install")).code).toBe(0);
  expect(await lockOf(app)).toContain(second);
  expect(await lockOf(app)).not.toContain(first);

  // Adding it again with the commit in place of the branch pins it in package.json.
  expect((await bun(app, "add", `${url}#${second}`)).code).toBe(0);
  expect(await dependencyOf(app)).toBe(`${url}#${second}`);
}, 60_000);

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
