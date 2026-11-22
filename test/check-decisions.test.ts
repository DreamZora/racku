/**
 * Tests for the decision gate, `bun run check:decisions`.
 *
 * The rules come from the decision record specification below. AGENTS.md summarizes them under
 * "Decision records" and lists the command under "Commands"; change all of them together.
 *
 * @decision .agents/decisions/261112_035939-decision-records.md
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDecisions, formatProblem } from "../scripts/check-decisions.ts";

// Fixture references are assembled from this constant so that the real gate, which scans this
// file too, never sees them.
const TAG = "@decision";
const GATE = join(import.meta.dir, "..", "scripts", "check-decisions.ts");
const DIR = ".agents/decisions";
const REQUIRED = ["Background", "Decision", "Alternatives", "Impact"];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Writes `files`, keyed by path relative to the root, into a new temporary repository. */
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "racku-gate-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** Level-2 sections; section `i` (from 0) starts on line `5 + 4 * i` of a {@link record}. */
function sections(names: readonly string[] = REQUIRED): string {
  return names.map((name) => `## ${name}\n\n- Text.\n`).join("\n");
}

function record(status = "accepted", names: readonly string[] = REQUIRED): string {
  return `# Decision: Fixture\n\nStatus: ${status}\n\n${sections(names)}`;
}

async function problemsOf(files: Record<string, string>): Promise<string[]> {
  const { problems } = await checkDecisions(await repo(files));
  return problems.map(formatProblem);
}

// @decision .agents/decisions/261112_035939-decision-records.md#location-and-naming
// @decision .agents/decisions/261112_035939-decision-records.md#file-format
describe("decision records", () => {
  test("pass when they follow the documented format", async () => {
    const full = ["Background", "Decision", "Evidence", "Alternatives", "Impact"];
    const root = await repo({
      [`${DIR}/261112_120000-accepted-rule.md`]: record("accepted", [
        ...full,
        "Implementation",
        "Confirmation",
      ]),
      [`${DIR}/261112_120001-proposed-rule.md`]: record("proposed", [
        ...REQUIRED,
        "Open questions",
      ]),
      [`${DIR}/261112_120002-old-rule.md`]: record(
        "superseded — replaced by [261112_120000-accepted-rule.md](261112_120000-accepted-rule.md)",
      ),
      [`${DIR}/261112_120003-bad-idea.md`]: record("rejected — it breaks hot swap"),
      [`${DIR}/240229_235959-p0-leap-day.md`]: record(),
    });
    const result = await checkDecisions(root);
    expect(result.problems).toEqual([]);
    expect(result.decisions).toBe(5);
  });

  test("fail on file names outside <YYMMDD>_<hhmmss>-<topic>.md", async () => {
    const names = [
      "2611120_120000-rule.md",
      "261112-120000-rule.md",
      "261112_120000-Hot-Swap.md",
      "261112_120000-hot_swap.md",
      "261112_120000-.md",
      "261112_120000-rule.txt",
      "notes.md",
    ];
    const problems = await problemsOf(
      Object.fromEntries(names.map((name) => [`${DIR}/${name}`, record()])),
    );
    for (const name of names) {
      expect(problems).toContain(
        `${DIR}/${name}: file name must be \`<YYMMDD>_<hhmmss>-<topic>.md\``,
      );
    }
  });

  test("fail on timestamps that are not a real date and time", async () => {
    const names = [
      "261312_120000-month.md",
      "261131_120000-day.md",
      "250229_120000-not-leap.md",
      "261112_240000-hour.md",
      "261112_126000-minute.md",
    ];
    const problems = await problemsOf(
      Object.fromEntries(names.map((name) => [`${DIR}/${name}`, record()])),
    );
    expect(problems).toEqual(
      names
        .toSorted()
        .map((name) => `${DIR}/${name}: file name does not start with a real date and time`),
    );
  });

  test("fail on subdirectories", async () => {
    const problems = await problemsOf({ [`${DIR}/archive/261112_120000-rule.md`]: record() });
    expect(problems).toEqual([
      `${DIR}/archive: decision records are stored flat, without subdirectories`,
    ]);
  });

  test("require the fixed first three lines", async () => {
    const file = `${DIR}/261112_120000-rule.md`;
    const problems = await problemsOf({ [file]: `# Fixture\nStatus: accepted\n\n${sections()}` });
    expect(problems).toEqual([
      `${file}:1: line 1 must be \`# Decision: <title>\``,
      `${file}:2: line 2 must be blank`,
      `${file}:3: line 3 must be \`Status: <status>\``,
    ]);
  });

  test.each([
    "done",
    "Accepted",
    "rejected",
    "rejected - uses a hyphen instead of an em dash",
    "superseded — replaced by 261112_120001-new-rule.md",
  ])("fail on the status '%s'", async (status) => {
    const file = `${DIR}/261112_120000-rule.md`;
    expect(await problemsOf({ [file]: record(status) })).toEqual([
      expect.stringContaining(`${file}:3: status must be \`proposed\`, \`accepted\``),
    ]);
  });

  test("require a superseded record to link an existing replacement", async () => {
    const file = `${DIR}/261112_120000-rule.md`;
    const status = "superseded — replaced by [new rule](261201_000000-missing.md)";
    expect(await problemsOf({ [file]: record(status) })).toEqual([
      `${file}:3: replacement 261201_000000-missing.md is not a decision record`,
    ]);
  });

  test("require the four sections in order and allow only the optional ones", async () => {
    const file = `${DIR}/261112_120000-rule.md`;
    const names = ["Decision", "Background", "Notes", "Background", "Alternatives"];
    expect(await problemsOf({ [file]: record("accepted", names) })).toEqual([
      `${file}:1: missing section \`## Impact\``,
      `${file}:5: \`## Decision\` must come after \`## Background\``,
      `${file}:13: unknown section \`## Notes\``,
      `${file}:17: duplicate section \`## Background\``,
    ]);
  });

  test("allow `## Open questions` only in proposed records", async () => {
    const file = `${DIR}/261112_120000-accepted-rule.md`;
    const names = [...REQUIRED, "Open questions"];
    const problems = await problemsOf({
      [file]: record("accepted", names),
      [`${DIR}/261112_120001-proposed-rule.md`]: record("proposed", names),
    });
    expect(problems).toEqual([
      `${file}:21: \`## Open questions\` is allowed only in \`proposed\` decisions`,
    ]);
  });

  test("ignore headings inside fenced code blocks", async () => {
    const example = "\n  ```markdown\n  # Decision: <title>\n\n  ## Background\n  ```\n";
    expect(await problemsOf({ [`${DIR}/261112_120000-rule.md`]: record() + example })).toEqual([]);
  });
});

const RULE = "261112_120000-backplane-rule.md";
const PROPOSED = "261112_120001-proposed-rule.md";
const SUPERSEDED = "261112_120002-old-rule.md";
const RULE_TEXT = `${record()}\n### In-flight calls, pausing, and draining\n\n### Notes\n\n### Notes\n`;
const MISSING_REFERENCE = `// ${TAG} .agents/decisions/261201_000000-missing.md\n`;

// @decision .agents/decisions/261112_035939-decision-records.md#referencing-decisions-from-code
describe("code references", () => {
  test("pass when they name an accepted record and an existing heading", async () => {
    const root = await repo({
      [`${DIR}/${RULE}`]: RULE_TEXT,
      "src/a.ts": [
        "/**",
        ` * ${TAG} .agents/decisions/${RULE}`,
        " */",
        `// ${TAG} .agents/decisions/${RULE}#in-flight-calls-pausing-and-draining`,
        `// ${TAG} .agents/decisions/${RULE}#notes-1`,
        `// Prose that quotes the \`${TAG}\` tag in backticks is not a reference.`,
      ].join("\n"),
    });
    const result = await checkDecisions(root);
    expect(result.problems).toEqual([]);
    expect(result.references).toBe(3);
  });

  test("fail on missing, unaccepted, or malformed targets", async () => {
    const problems = await problemsOf({
      [`${DIR}/${RULE}`]: RULE_TEXT,
      [`${DIR}/${PROPOSED}`]: record("proposed"),
      [`${DIR}/${SUPERSEDED}`]: record(`superseded — replaced by [${RULE}](${RULE})`),
      "src/a.ts": [
        `// ${TAG} .agents/decisions/261201_000000-missing.md`,
        `// ${TAG} .agents/decisions/${PROPOSED}`,
        `// ${TAG} .agents/decisions/${SUPERSEDED}`,
        `// ${TAG} .agents/decisions/${RULE}#no-such-heading`,
        `// ${TAG} decisions/${RULE}`,
        `// ${TAG}`,
      ].join("\n"),
    });
    expect(problems).toEqual([
      "src/a.ts:1: 261201_000000-missing.md is not a decision record",
      `src/a.ts:2: ${PROPOSED} is proposed; code may reference only accepted decisions`,
      `src/a.ts:3: ${SUPERSEDED} is superseded; code may reference only accepted decisions`,
      `src/a.ts:4: ${RULE} has no #no-such-heading`,
      `src/a.ts:5: "decisions/${RULE}" is not a path under .agents/decisions/`,
      `src/a.ts:6: \`${TAG}\` must be followed by a decision path`,
    ]);
  });

  test("are read from code files outside dot directories and node_modules", async () => {
    const problems = await problemsOf({
      [`${DIR}/${RULE}`]: RULE_TEXT,
      "examples/shop/devices/orders.ts": MISSING_REFERENCE,
      "scripts/tool.mjs": MISSING_REFERENCE,
      "test/view.test.tsx": MISSING_REFERENCE,
      "node_modules/pkg/index.js": MISSING_REFERENCE,
      "examples/shop/node_modules/pkg/index.ts": MISSING_REFERENCE,
      "examples/shop/.rack/firmware/orders-abc123.js": MISSING_REFERENCE,
      "docs/guide.md": MISSING_REFERENCE,
    });
    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "examples/shop/devices/orders.ts",
      "scripts/tool.mjs",
      "test/view.test.tsx",
    ]);
  });
});

async function runGate(cwd: string) {
  const child = Bun.spawn([process.execPath, GATE], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#commands
describe("command line", () => {
  test("exits 0 and reports what it checked", async () => {
    const root = await repo({
      [`${DIR}/${RULE}`]: RULE_TEXT,
      "src/a.ts": `// ${TAG} .agents/decisions/${RULE}\n`,
    });
    const { stdout, exitCode } = await runGate(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("no problems in 1 record(s) and 1 reference(s)");
  });

  test("prints <file>:<line>: <problem> and exits 1", async () => {
    const root = await repo({
      [`${DIR}/${RULE}`]: RULE_TEXT,
      "src/a.ts": `\n\n// ${TAG} .agents/decisions/${RULE}#nope\n`,
    });
    const { stderr, exitCode } = await runGate(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`src/a.ts:3: ${RULE} has no #nope`);
  });

  test("exits 1 outside a repository root", async () => {
    const { stderr, exitCode } = await runGate(await repo({}));
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".agents/decisions: directory not found");
  });
});
