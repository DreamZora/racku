/**
 * Decision gate: checks the decision records under `.agents/decisions/` and the `@decision`
 * references in code.
 *
 * Run it from the repository root with `bun run check:decisions`. It prints one
 * `<file>:<line>: <problem>` line per problem and exits with code 1 when it finds any.
 *
 * @decision .agents/decisions/261112_035939-decision-records.md
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { headingAnchors, headingsOf } from "./markdown.ts";

/** A rule violation found by the gate. */
export interface Problem {
  /** Path relative to the checked root, with `/` separators. */
  file: string;
  /** 1-based line number; absent when the problem concerns the whole file. */
  line?: number;
  message: string;
}

/** Result of {@link checkDecisions}. */
export interface CheckResult {
  /** Problems sorted by file, then line. */
  problems: Problem[];
  /** Number of decision records read. */
  decisions: number;
  /** Number of `@decision` references found in code. */
  references: number;
}

type Status = "proposed" | "accepted" | "superseded" | "rejected";

interface DecisionRecord {
  /** `undefined` when the status line is malformed. */
  status: Status | undefined;
  anchors: Set<string>;
}

const DECISIONS_DIR = ".agents/decisions";
// Topics may contain digits: the accepted record `p0-scope-and-toolchain` already does.
const FILE_NAME = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED_SECTIONS = ["Background", "Decision", "Alternatives", "Impact"];
const OPTIONAL_SECTIONS = ["Evidence", "Implementation", "Open questions", "Confirmation"];
const SECTIONS = new Set([...REQUIRED_SECTIONS, ...OPTIONAL_SECTIONS]);
const SUPERSEDED = /^superseded — replaced by \[[^\]]+\]\((?:\.\/)?([^)\s/]+)\)$/;
const REJECTED = /^rejected — \S/;
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// A tag is `@decision` followed by whitespace or the end of the line, so prose that quotes
// the tag in backticks is not mistaken for a reference.
const REFERENCE_TAG = /@decision(?:\s+(\S+)|\s*$)/g;
const REFERENCE_TARGET = /^\.agents\/decisions\/([^/#]+)(?:#(.+))?$/;

/**
 * Checks the decision records and the code references under a repository root.
 *
 * @param root Repository root; records are read from `.agents/decisions/` below it, and code is
 *   every `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, or `.cjs` file outside
 *   `node_modules` and dot directories.
 * @returns The problems found and how many records and references were checked.
 * @throws When a directory cannot be read for a reason other than not existing.
 */
export async function checkDecisions(root: string): Promise<CheckResult> {
  const problems: Problem[] = [];
  const records = await readRecords(root, problems);
  let references = 0;
  for await (const path of codeFiles(root)) {
    const file = toPosix(relative(root, path));
    const lines = (await Bun.file(path).text()).split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      for (const match of text.matchAll(REFERENCE_TAG)) {
        references++;
        const message = checkReference(match[1], records);
        if (message !== undefined) problems.push({ file, line: index + 1, message });
      }
    }
  }
  problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return { problems, decisions: records.size, references };
}

async function readRecords(
  root: string,
  problems: Problem[],
): Promise<Map<string, DecisionRecord>> {
  const records = new Map<string, DecisionRecord>();
  const entries = await listDirectory(join(root, DECISIONS_DIR));
  if (entries === undefined) {
    problems.push({
      file: DECISIONS_DIR,
      message: "directory not found; run the gate from the repository root",
    });
    return records;
  }
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const entry of entries) {
    const file = `${DECISIONS_DIR}/${entry.name}`;
    if (entry.isDirectory()) {
      problems.push({ file, message: "decision records are stored flat, without subdirectories" });
      continue;
    }
    const nameMatch = FILE_NAME.exec(entry.name);
    if (nameMatch === null) {
      problems.push({ file, message: "file name must be `<YYMMDD>_<hhmmss>-<topic>.md`" });
    } else if (!isRealTimestamp(nameMatch)) {
      problems.push({ file, message: "file name does not start with a real date and time" });
    }
    if (!entry.name.endsWith(".md")) continue;
    const text = await Bun.file(join(root, file)).text();
    records.set(entry.name, checkRecord(file, text, names, problems));
  }
  return records;
}

function checkRecord(
  file: string,
  text: string,
  names: ReadonlySet<string>,
  problems: Problem[],
): DecisionRecord {
  const lines = text.split(/\r?\n/);
  const report = (line: number, message: string) => problems.push({ file, line, message });

  if (!/^# Decision: \S/.test(lines[0] ?? "")) report(1, "line 1 must be `# Decision: <title>`");
  if (lines[1] !== "") report(2, "line 2 must be blank");
  const status = readStatus(lines[2] ?? "", names, (message) => report(3, message));

  const headings = headingsOf(lines);
  const sectionLines = new Map<string, number>();
  for (const { level, text: name, line } of headings) {
    if (level !== 2) continue;
    if (!SECTIONS.has(name)) {
      report(line, `unknown section \`## ${name}\``);
    } else if (sectionLines.has(name)) {
      report(line, `duplicate section \`## ${name}\``);
    } else {
      sectionLines.set(name, line);
    }
  }
  let previous: { name: string; line: number } | undefined;
  for (const name of REQUIRED_SECTIONS) {
    const line = sectionLines.get(name);
    if (line === undefined) {
      report(1, `missing section \`## ${name}\``);
      continue;
    }
    if (previous !== undefined && line < previous.line) {
      report(line, `\`## ${name}\` must come after \`## ${previous.name}\``);
    }
    previous = { name, line };
  }
  const openQuestions = sectionLines.get("Open questions");
  if (openQuestions !== undefined && status !== undefined && status !== "proposed") {
    report(openQuestions, "`## Open questions` is allowed only in `proposed` decisions");
  }
  return { status, anchors: new Set(headingAnchors(headings)) };
}

function readStatus(
  line: string,
  names: ReadonlySet<string>,
  report: (message: string) => void,
): Status | undefined {
  if (!line.startsWith("Status: ")) {
    report("line 3 must be `Status: <status>`");
    return undefined;
  }
  const value = line.slice("Status: ".length);
  if (value === "proposed" || value === "accepted") return value;
  const superseded = SUPERSEDED.exec(value);
  if (superseded !== null) {
    const target = superseded[1] ?? "";
    if (!names.has(target)) report(`replacement ${target} is not a decision record`);
    return "superseded";
  }
  if (REJECTED.test(value)) return "rejected";
  report(
    "status must be `proposed`, `accepted`, `superseded — replaced by [<file>](<file>)`, " +
      "or `rejected — <reason>`",
  );
  return undefined;
}

function checkReference(
  target: string | undefined,
  records: ReadonlyMap<string, DecisionRecord>,
): string | undefined {
  if (target === undefined) return "`@decision` must be followed by a decision path";
  const match = REFERENCE_TARGET.exec(target);
  if (match === null) return `"${target}" is not a path under ${DECISIONS_DIR}/`;
  const [, name = "", anchor] = match;
  const record = records.get(name);
  if (record === undefined) return `${name} is not a decision record`;
  if (record.status !== "accepted") {
    return `${name} is ${record.status ?? "malformed"}; code may reference only accepted decisions`;
  }
  if (anchor !== undefined && !record.anchors.has(anchor)) return `${name} has no #${anchor}`;
  return undefined;
}

function isRealTimestamp(match: RegExpExecArray): boolean {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match
    .slice(1, 7)
    .map(Number);
  const time = new Date(Date.UTC(2000 + year, month - 1, day, hour, minute, second));
  return (
    time.getUTCMonth() === month - 1 &&
    time.getUTCDate() === day &&
    time.getUTCHours() === hour &&
    time.getUTCMinutes() === minute &&
    time.getUTCSeconds() === second
  );
}

async function* codeFiles(dir: string): AsyncGenerator<string> {
  for (const entry of (await listDirectory(dir)) ?? []) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* codeFiles(path);
    else if (entry.isFile() && CODE_FILE.test(entry.name)) yield path;
  }
}

/** Lists a directory sorted by name, or returns `undefined` when it does not exist. */
async function listDirectory(dir: string): Promise<Dirent[] | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Formats a problem the way the gate prints it.
 *
 * @param problem The problem to format.
 * @returns `<file>:<line>: <message>`, or `<file>: <message>` when there is no line.
 */
export function formatProblem({ file, line, message }: Problem): string {
  return line === undefined ? `${file}: ${message}` : `${file}:${line}: ${message}`;
}

if (import.meta.main) {
  const { problems, decisions, references } = await checkDecisions(process.cwd());
  for (const problem of problems) console.error(formatProblem(problem));
  if (problems.length > 0) {
    console.error(`decision gate: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `decision gate: no problems in ${decisions} record(s) and ${references} reference(s)`,
    );
  }
}
