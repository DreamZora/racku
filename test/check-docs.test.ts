/**
 * Tests for the documentation gate, `bun run check:docs`.
 *
 * AGENTS.md lists the command under "Commands" and its rules under "Development workflow"; change
 * them together with these tests.
 *
 * @decision .agents/decisions/261119_055008-documentation.md#tests-that-hold-the-documentation
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatProblem } from "../scripts/check-decisions.ts";
import { checkDocs } from "../scripts/check-docs.ts";

// Fixture references are assembled from this constant so that the real gate, which scans this
// file too, never sees them.
const TAG = "@doc";
const GATE = join(import.meta.dir, "..", "scripts", "check-docs.ts");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Writes `files`, keyed by path relative to the root, into a new temporary repository. */
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "racku-docs-gate-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** A test file whose comments name each of `targets`. */
function tests(...targets: string[]): string {
  return targets.map((target) => `// ${TAG} ${target}\n`).join("");
}

/** The problem the gate reports for a section at `file:line` that no test names. */
function unnamed(file: string, line: number, anchor: string): string {
  const fix = `add \`${TAG} ${file}#${anchor}\` to a test that confirms the section`;
  return `${file}:${line}: no test names #${anchor}; ${fix}, or begin it with \`<!-- no claims: <reason> -->\``;
}

async function problemsOf(files: Record<string, string>): Promise<string[]> {
  const { problems } = await checkDocs(await repo(files));
  return problems.map(formatProblem);
}

const GUIDE =
  "# Devices\n\nWhat a device is.\n\n## Hooks\n\nThe order of the hooks.\n\n### Errors\n\nCodes.\n";
const MAP = "# Documentation\n\n- [Devices](guides/devices.md)\n";

describe("the documentation gate", () => {
  test("passes when tests name every section of the guides and the reference", async () => {
    const root = await repo({
      "README.md": "# App\n\n## Start\n\nSee [the guide](docs/guides/devices.md#hooks).\n",
      "docs/README.md": `${MAP}- [Errors](reference/errors.md)\n`,
      "docs/guides/devices.md": GUIDE,
      "docs/reference/errors.md": "# Errors\n\n## Codes\n\nEvery code.\n",
      "test/devices.test.ts": tests(
        "docs/guides/devices.md#hooks",
        "docs/guides/devices.md#errors",
        "docs/reference/errors.md#codes",
        "README.md#start",
      ),
    });
    const { problems, documents, sections, references, links } = await checkDocs(root);
    expect(problems).toEqual([]);
    expect({ documents, sections, references, links }).toEqual({
      documents: 4,
      sections: 3,
      references: 4,
      links: 3,
    });
  });

  test("fails on a reference to a document or a heading that doesn't exist", async () => {
    const problems = await problemsOf({
      "docs/README.md": MAP,
      "docs/guides/devices.md": GUIDE,
      "test/a.test.ts": tests(
        "docs/guides/devices.md#hooks",
        "docs/guides/devices.md#errors",
        "docs/guides/missing.md#hooks",
        "docs/guides/devices.md#nothing",
        "src/device.ts",
      ),
      "test/b.test.ts": `// ${TAG}\n`,
    });
    expect(problems).toEqual([
      "test/a.test.ts:3: docs/guides/missing.md is not a document",
      "test/a.test.ts:4: docs/guides/devices.md has no #nothing",
      'test/a.test.ts:5: "src/device.ts" is not README.md or a document under docs/',
      "test/b.test.ts:1: `@doc` must be followed by a document path",
    ]);
  });

  test("fails on a section of a guide or the reference that no test names", async () => {
    const problems = await problemsOf({
      "docs/README.md": `${MAP}- [Errors](reference/errors.md)\n- [Concepts](concepts.md)\n`,
      "docs/guides/devices.md": GUIDE,
      "docs/reference/errors.md": "# Errors\n\n## Codes\n\nEvery code.\n",
      "docs/concepts.md": "# Concepts\n\n## Racks\n\nExplained.\n",
      "test/a.test.ts": tests("docs/guides/devices.md#hooks"),
    });
    expect(problems).toEqual([
      unnamed("docs/guides/devices.md", 9, "errors"),
      unnamed("docs/reference/errors.md", 3, "codes"),
    ]);
  });

  test("accepts a section that begins with a reason it makes no claims", async () => {
    const guide =
      "# Devices\n\n## Overview\n\n<!-- no claims: it lists the sections below -->\n\nLinks.\n\n## Empty\n\n<!-- no claims: -->\n";
    const problems = await problemsOf({
      "docs/README.md": MAP,
      "docs/guides/devices.md": guide,
    });
    expect(problems).toEqual([unnamed("docs/guides/devices.md", 9, "empty")]);
  });

  test("fails on links and anchors that lead nowhere, and skips other schemes and code", async () => {
    const readme = [
      "# App",
      "",
      "[ok](docs/guides/devices.md#hooks) [dir](src) [self](#app) [web](https://bun.sh/x#y)",
      "[gone](docs/gone.md) [anchor](docs/guides/devices.md#nope) [here](#nope)",
      "`[code](nowhere.md)` and [out](../outside.md) and [empty]() and [bad](a%zz.md)",
      "",
      "```md",
      "[fenced](nowhere.md)",
      "```",
      "",
    ].join("\n");
    const problems = await problemsOf({
      "README.md": readme,
      "src/index.ts": "",
      "docs/README.md": MAP,
      "docs/guides/devices.md": GUIDE,
      "test/a.test.ts": tests("docs/guides/devices.md#hooks", "docs/guides/devices.md#errors"),
    });
    expect(problems).toEqual([
      "README.md:4: docs/gone.md leads to nothing: docs/gone.md doesn't exist",
      "README.md:4: docs/guides/devices.md#nope leads to nothing: docs/guides/devices.md has no #nope",
      "README.md:4: #nope leads to nothing: README.md has no #nope",
      "README.md:5: ../outside.md leads outside the repository",
      "README.md:5: empty link",
      "README.md:5: a%zz.md is not a valid link: a % escape is malformed",
    ]);
  });

  // An app copies a skill's folder into its .claude/skills/, away from the rest of the package,
  // so a skill names the documentation by its path in the app.
  // @decision .agents/decisions/261119_074252-trial-apps.md#the-skill
  test("checks the skills under skills/: links that stay in their folder, and paths in an app", async () => {
    const skill = [
      "# racku",
      "",
      "[ok](reference.md#more) [gone](missing.md) [out](../../docs/guides/devices.md#hooks)",
      "`node_modules/racku/docs/guides/devices.md#hooks` `node_modules/racku/` `node_modules/racku/src`",
      "`node_modules/racku/docs/nothing.md` `node_modules/racku/docs/guides/devices.md#nope`",
      "`node_modules/racku/../x.md` `node_modules/other/x.md` `racku/docs/nothing.md`",
      "",
    ].join("\n");
    const { problems, links } = await checkDocs(
      await repo({
        "README.md": "# App\n\nIn an app: `node_modules/racku/docs/gone.md`.\n",
        "docs/README.md": MAP,
        "docs/guides/devices.md": GUIDE,
        "src/index.ts": "",
        "skills/racku/SKILL.md": skill,
        "skills/racku/reference.md": "# Reference\n\n## More\n\n[back](SKILL.md)\n",
        "test/a.test.ts": tests("docs/guides/devices.md#hooks", "docs/guides/devices.md#errors"),
      }),
    );
    expect(problems.map(formatProblem)).toEqual([
      "README.md:3: node_modules/racku/docs/gone.md leads to nothing: docs/gone.md doesn't exist",
      "skills/racku/SKILL.md:3: missing.md leads to nothing: skills/racku/missing.md doesn't exist",
      "skills/racku/SKILL.md:3: ../../docs/guides/devices.md#hooks leaves the skill's folder, which an app copies on its own; name the file by its path in an app, `node_modules/racku/docs/guides/devices.md#hooks`",
      "skills/racku/SKILL.md:5: node_modules/racku/docs/nothing.md leads to nothing: docs/nothing.md doesn't exist",
      "skills/racku/SKILL.md:5: node_modules/racku/docs/guides/devices.md#nope leads to nothing: docs/guides/devices.md has no #nope",
      "skills/racku/SKILL.md:6: node_modules/racku/../x.md leads outside the package",
    ]);
    // The map's link, the README's path, the skill's 3 links and 6 paths, and the reference's link.
    expect(links).toBe(12);
  });

  test("fails when the map of docs/ doesn't link to a document", async () => {
    const problems = await problemsOf({
      "docs/README.md": MAP,
      "docs/guides/devices.md": GUIDE,
      "docs/design.md": "# Design\n",
      "test/a.test.ts": tests("docs/guides/devices.md#hooks", "docs/guides/devices.md#errors"),
    });
    expect(problems).toEqual(["docs/README.md: the map has no link to docs/design.md"]);
  });

  test("the command prints each problem and exits with code 1", async () => {
    const root = await repo({ "docs/README.md": MAP, "docs/guides/devices.md": GUIDE });
    const run = Bun.spawn([process.execPath, GATE], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("docs/guides/devices.md:5: no test names #hooks");
    expect(stderr).toContain("documentation gate: 2 problem(s)");
  });

  test("the command reports what it checked when it finds nothing", async () => {
    const root = await repo({
      "docs/README.md": MAP,
      "docs/guides/devices.md": GUIDE,
      "test/a.test.ts": tests("docs/guides/devices.md#hooks", "docs/guides/devices.md#errors"),
    });
    const run = Bun.spawn([process.execPath, GATE], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([run.exited, new Response(run.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain(
      "documentation gate: no problems in 2 document(s), with 2 section(s) held by tests, 2 reference(s), and 1 link(s)",
    );
  });
});
