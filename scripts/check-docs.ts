/**
 * Documentation gate: checks that tests hold the documentation in `README.md` and `docs/`, and
 * that its links, and those of the skills under `skills/`, lead somewhere.
 *
 * - Every `@doc <document>#<anchor>` reference in a test under `test/` names a document and a
 *   heading that exist.
 * - Every section of a document under `docs/guides/` or `docs/reference/`, each heading from `##`
 *   down, is named by a test, unless the section begins with `<!-- no claims: <reason> -->`.
 * - Every relative link and anchor in `README.md`, `docs/`, and `skills/` leads to a file, a
 *   directory, or a heading that exists, and `docs/README.md` links to every other document under
 *   `docs/`.
 *
 * Run it from the repository root with `bun run check:docs`. It prints one
 * `<file>:<line>: <problem>` line per problem and exits with code 1 when it finds any.
 *
 * @decision .agents/decisions/261119_055008-documentation.md#tests-that-hold-the-documentation
 * @decision .agents/decisions/261119_074252-trial-apps.md#the-skill
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { formatProblem, type Problem } from "./check-decisions.ts";
import { type Heading, headingAnchors, headingsOf, linesOutsideFences } from "./markdown.ts";

/** Result of {@link checkDocs}. */
export interface DocsResult {
  /** Problems sorted by file, then line. */
  problems: Problem[];
  /** Number of documents read: `README.md` and every Markdown file under `docs/`. */
  documents: number;
  /** Number of sections that tests must name, those of the guides and the reference. */
  sections: number;
  /** Number of `@doc` references found in tests. */
  references: number;
  /** Number of relative links and anchors checked. */
  links: number;
}

interface Document {
  /** Path relative to the root, with `/` separators. */
  file: string;
  lines: string[];
  headings: Heading[];
  /** The anchor of each heading, in the order of `headings`. */
  anchors: string[];
}

const README = "README.md";
const DOCS_DIR = "docs";
const SKILLS_DIR = "skills";
const MAP = "docs/README.md";
const TESTS_DIR = "test";
/** Documents whose every section a test must name. */
const HELD = /^docs\/(?:guides|reference)\//;
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// A tag is `@doc` followed by whitespace or the end of the line, so prose that quotes the tag in
// backticks is not mistaken for a reference.
const REFERENCE_TAG = /@doc(?:\s+(\S+)|\s*$)/g;
const REFERENCE_TARGET = /^((?:README\.md|docs\/[^#\s]+\.md))(?:#(.+))?$/;
const NO_CLAIMS = /^<!-- no claims: \S.*-->$/;
// An inline link or image, `[text](target)` or `[text](target "title")`.
const LINK = /!?\[[^\]]*\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;
const INLINE_CODE = /(`+)[^`]+?\1/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Checks the documentation under a repository root against its tests and its links.
 *
 * @param root Repository root: documents are `README.md` and the Markdown files under `docs/`,
 *   and references are read from the code files under `test/`, outside `node_modules` and dot
 *   directories.
 * @returns The problems found, and how much was checked.
 * @throws When a directory or file cannot be read for a reason other than not existing.
 */
export async function checkDocs(root: string): Promise<DocsResult> {
  const problems: Problem[] = [];
  const documents = await readDocuments(root);
  const named = new Set<string>();
  let references = 0;
  for await (const path of filesBelow(join(root, TESTS_DIR), CODE_FILE)) {
    const file = toPosix(relative(root, path));
    const lines = (await Bun.file(path).text()).split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      for (const match of text.matchAll(REFERENCE_TAG)) {
        references++;
        const target = match[1];
        const message = checkReference(target, documents);
        if (message !== undefined) problems.push({ file, line: index + 1, message });
        else if (target !== undefined) named.add(target);
      }
    }
  }

  let sections = 0;
  for (const document of documents.values()) {
    if (!HELD.test(document.file)) continue;
    for (const [index, heading] of document.headings.entries()) {
      if (heading.level < 2) continue;
      sections++;
      const target = `${document.file}#${document.anchors[index]}`;
      if (named.has(target)) continue;
      const first = document.lines.slice(heading.line).find((line) => line.trim() !== "");
      if (first !== undefined && NO_CLAIMS.test(first.trim())) continue;
      problems.push({
        file: document.file,
        line: heading.line,
        message: `no test names #${document.anchors[index]}; add \`@doc ${target}\` to a test that confirms the section, or begin it with \`<!-- no claims: <reason> -->\``,
      });
    }
  }

  let links = 0;
  const mapped = new Set<string>();
  for (const document of documents.values()) {
    for (const { text, line } of linesOutsideFences(document.lines)) {
      for (const match of text
        .replace(INLINE_CODE, (code) => " ".repeat(code.length))
        .matchAll(LINK)) {
        const target = match[1] ?? "";
        if (SCHEME.test(target)) continue;
        links++;
        const result = await checkLink(root, document, target, documents);
        if (typeof result === "string")
          problems.push({ file: document.file, line, message: result });
        else if (document.file === MAP) mapped.add(result.file);
      }
    }
  }
  if (documents.has(MAP)) {
    for (const file of documents.keys()) {
      if (file.startsWith(`${DOCS_DIR}/`) && file !== MAP && !mapped.has(file)) {
        problems.push({ file: MAP, message: `the map has no link to ${file}` });
      }
    }
  }

  problems.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return { problems, documents: documents.size, sections, references, links };
}

async function readDocuments(root: string): Promise<Map<string, Document>> {
  const paths: string[] = [];
  if (await Bun.file(join(root, README)).exists()) paths.push(join(root, README));
  for await (const path of filesBelow(join(root, DOCS_DIR), /\.md$/)) paths.push(path);
  for await (const path of filesBelow(join(root, SKILLS_DIR), /\.md$/)) paths.push(path);
  const documents = new Map<string, Document>();
  for (const path of paths) {
    const file = toPosix(relative(root, path));
    const lines = (await Bun.file(path).text()).split(/\r?\n/);
    const headings = headingsOf(lines);
    documents.set(file, { file, lines, headings, anchors: headingAnchors(headings) });
  }
  return documents;
}

function checkReference(
  target: string | undefined,
  documents: ReadonlyMap<string, Document>,
): string | undefined {
  if (target === undefined) return "`@doc` must be followed by a document path";
  const match = REFERENCE_TARGET.exec(target);
  if (match === null) return `"${target}" is not ${README} or a document under ${DOCS_DIR}/`;
  const [, file = "", anchor] = match;
  const document = documents.get(file);
  if (document === undefined) return `${file} is not a document`;
  if (anchor !== undefined && !document.anchors.includes(anchor))
    return `${file} has no #${anchor}`;
  return undefined;
}

/**
 * Checks one relative link of a document.
 *
 * @returns The problem, or the linked path relative to the root when the link resolves.
 */
async function checkLink(
  root: string,
  document: Document,
  target: string,
  documents: ReadonlyMap<string, Document>,
): Promise<string | { file: string }> {
  if (target === "") return "empty link";
  const hash = target.indexOf("#");
  let path: string;
  let anchor: string | undefined;
  try {
    path = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
    anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  } catch {
    return `${target} is not a valid link: a % escape is malformed`;
  }
  let file = document.file;
  if (path !== "") {
    const resolved = toPosix(relative(root, join(root, dirname(document.file), path)));
    if (resolved.startsWith("../") || resolved === "..")
      return `${target} leads outside the repository`;
    if (!(await exists(join(root, resolved))))
      return `${target} leads to nothing: ${resolved} doesn't exist`;
    file = resolved;
  }
  if (anchor === undefined || !file.endsWith(".md")) return { file };
  const linked = documents.get(file) ?? (await readMarkdown(root, file));
  if (!linked.anchors.includes(anchor))
    return `${target} leads to nothing: ${file} has no #${anchor}`;
  return { file };
}

async function readMarkdown(root: string, file: string): Promise<Document> {
  const lines = (await Bun.file(join(root, file)).text()).split(/\r?\n/);
  const headings = headingsOf(lines);
  return { file, lines, headings, anchors: headingAnchors(headings) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function* filesBelow(dir: string, name: RegExp): AsyncGenerator<string> {
  for (const entry of (await listDirectory(dir)) ?? []) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesBelow(path, name);
    else if (entry.isFile() && name.test(entry.name)) yield path;
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

if (import.meta.main) {
  const { problems, documents, sections, references, links } = await checkDocs(process.cwd());
  for (const problem of problems) console.error(formatProblem(problem));
  if (problems.length > 0) {
    console.error(`documentation gate: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `documentation gate: no problems in ${documents} document(s), with ${sections} section(s) held by tests, ${references} reference(s), and ${links} link(s)`,
    );
  }
}
