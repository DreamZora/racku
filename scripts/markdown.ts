/**
 * Headings and their anchors in Markdown, as the decision gate and the documentation gate read
 * them.
 *
 * @decision .agents/decisions/261112_035939-decision-records.md#referencing-decisions-from-code
 * @decision .agents/decisions/261119_055008-documentation.md#tests-that-hold-the-documentation
 */

/** An ATX heading of a Markdown file. */
export interface Heading {
  /** 1 for `#`, up to 6. */
  level: number;
  /** The heading's text, without the leading and closing `#`s. */
  text: string;
  /** 1-based line number. */
  line: number;
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * Collects the ATX headings outside fenced code blocks.
 *
 * @param lines The file's lines.
 * @returns The headings, in file order.
 */
export function headingsOf(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  for (const { text, line } of linesOutsideFences(lines)) {
    const heading = HEADING.exec(text);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      headings.push({ level: heading[1].length, text: heading[2], line });
    }
  }
  return headings;
}

/**
 * Lists the lines outside fenced code blocks.
 *
 * @param lines The file's lines.
 * @returns Each such line with its 1-based number.
 */
export function linesOutsideFences(lines: readonly string[]): { text: string; line: number }[] {
  const outside: { text: string; line: number }[] = [];
  let fence: string | undefined;
  for (const [index, text] of lines.entries()) {
    const fenceMatch = FENCE.exec(text);
    if (fenceMatch !== null) {
      const [, marker = "", rest = ""] = fenceMatch;
      if (fence === undefined) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === "") {
        fence = undefined;
      }
      continue;
    }
    if (fence === undefined) outside.push({ text, line: index + 1 });
  }
  return outside;
}

/**
 * Derives the anchor of each heading the way GitHub does, numbering repeated headings.
 *
 * @param headings The headings of one file, in file order.
 * @returns One anchor per heading, in the same order.
 */
export function headingAnchors(headings: readonly Heading[]): string[] {
  const seen = new Map<string, number>();
  return headings.map(({ text }) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
}
