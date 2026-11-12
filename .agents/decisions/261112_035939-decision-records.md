# Decision: Record engineering decisions in .agents/decisions and reference them from code

Status: accepted

## Background

- The project advances through multiple Agents and people in turn. Looking only at the code and the conversation, a later contributor cannot tell why something is done a certain way, or which options were rejected at the time, so the same questions are reopened or the architecture is changed without authorization.
- The user asked to follow the engineering management approach of deepseek-harness: a decision and its reasons are written as a separate document, rule documents and code link to that decision, and the reasons are not repeated in many places.

## Decision

### Location and naming

- Decision records live in `.agents/decisions/`, stored flat, with no subdirectories.
- `.agents/` holds engineering process material for Agents and maintainers; `docs/` holds only user-facing project documentation and no decision records.
- File names follow the format `<YYMMDD>_<hhmmss>-<topic>.md`.
  - `YYMMDD_hhmmss` is the local time when the record is first written, in 24-hour form, zero-padded to two digits.
  - `topic` uses lowercase English words joined by hyphens.
- Example: `261112_035943-hot-swap.md` means the record was written on 2026-11-12 at 03:59:43.
- A file name is never changed once committed. Sorting by file name gives the timeline, so no separate index file is kept.

### File format

- The first three lines are fixed:

  ```markdown
  # Decision: <title>

  Status: <status>
  ```

- The status takes exactly one of these four values:
  - `proposed`: proposed and waiting for user confirmation; implementation code may not be written on its basis.
  - `accepted`: the user has confirmed it and it may be implemented.
  - `superseded — replaced by [<file>](<file>)`: replaced by a newer decision.
  - `rejected — <one-line reason>`: rejected.
- The body must contain the following sections in order:
  - `## Background`: the problem to solve, readable without seeing the solution.
  - `## Decision`: how it is done now, stated in the present tense.
  - `## Alternatives`: every option that was genuinely considered, and why it lost. Do not invent options that were never discussed; when there truly is no alternative, write "None" and explain why.
  - `## Impact`: what this tradeoff gains, what it costs, and which follow-up work it creates.
- The following sections are added as needed:
  - `## Evidence`: measured data or external sources.
  - `## Implementation`: the paths that hold the implementation, filled in after implementation.
  - `## Open questions`: used only in the `proposed` status.
  - `## Confirmation`: required when the decision was not confirmed directly by the user; state the confirmation method, the source of the authorization, and the date.
- Decisions reference each other with relative links, for example `[Hot swap and hot reload](261112_035943-hot-swap.md)`.
- Section headings stay short so that anchors are easy to reference.

### Lifecycle

- An Agent may draft a `proposed` decision; the status may change to `accepted` only after explicit user confirmation.
- Exception: when the user explicitly authorizes an Agent to decide on its own for a piece of work, the Agent may set a decision it drafted directly to `accepted` and must state the source of the authorization and the date in `## Confirmation`. The authorization covers only the work it was granted for and does not carry over to later sessions.
- When a difficult decision with no clear tradeoff comes up during an authorized period, refer it first to the review model designated by the user (currently Fable) for a conclusion, finalize according to that conclusion, and record the review in `## Confirmation`.
- The decision content of an `accepted` decision is never rewritten. To change a decision, write a new one: link the superseded decision from the new one and change the status line of the old decision to `superseded — replaced by [...](...)`.
- The only content that may be modified, and that must be kept in sync with the code, is implementation fact such as paths, symbol names, and default values.
- A rejected proposal is kept as `rejected` if its reasons can prevent the same mistake later; otherwise it is deleted.

### When a decision is required

- A decision is required for the following:
  - Architecture and module boundaries
  - Public APIs and interface standards
  - The backplane protocol and data formats
  - New runtime dependencies
  - Toolchain, repository layout, and engineering process
  - Breaking changes
  - Security rules
  - Any practice that departs from an existing decision
- A decision is not required for local mechanical changes (renaming a local variable, fixing a typo, formatting) or for defect fixes that do not change established behavior.
- When a topic already has a decision, update only its implementation facts or write a new decision that supersedes it; do not write another duplicate decision.

### Referencing decisions from code

- The reference format is `@decision .agents/decisions/<file>`, optionally followed by `#<section-anchor>`. Both JSDoc blocks and line comments use this format so that it can be found with grep and checked by script later.
- Example: `// @decision .agents/decisions/261112_035943-hot-swap.md#lifecycle`
- A decision must be referenced in the following places:
  - A module that implements a decision: referenced in the JSDoc at the top of the file.
  - Code that is determined by a decision and would look wrong or redundant without it: referenced with a line comment at that spot. For example, the main thread deliberately does not import device code.
  - A test that pins the behavior of a decision: referenced in a comment on the `describe` block or the test case.
- A referenced decision must exist and have the status `accepted`. When a decision is superseded, change the references in the code to the new decision in the same change.
- Not every line needs a reference; add one only where a reader would ask "why is it written this way".
- The `Context:` section of the commit message lists the relevant decision files.

## Alternatives

- **Place them in `docs/decisions/`**: this was the initial approach. The user later decided that `docs/` holds only project documentation and that decision records move under `.agents/`, following deepseek-harness.
- **Copy the deepseek-harness directory structure exactly** as `{lifecycle}/{category}/yyyy-mm-dd-topic.md`: a status change would move the file, and the paths referenced from code would break with it. This project requires code to reference decisions, so the paths must stay stable; the status therefore lives inside the file and the directory stays flat.
- **Name files by date only**: several decisions on the same day cannot be ordered, and names collide easily. The user specified `<YYMMDD>_<hhmmss>` with second precision.
- **Maintain one central index file**: it duplicates the content and the file names, and every new decision edits the same file, which conflicts easily.
- **Write only rules in AGENTS.md and record no reasons**: a later contributor cannot tell whether a rule can be bent, so questions are reopened or rules are changed beyond the authority to do so.

## Impact

- Every non-local change needs an `accepted` decision first, which slows progress; in exchange, the architecture cannot be quietly changed by a single session.
- References from code tie the implementation to its reasons; when a decision is superseded, the references must be updated together, otherwise they are left pointing at the old decision.
- There is no script yet that checks the format and the references, so only Agent self-review and human review catch problems. Add the check script when the P0 project is set up, and write a separate decision then.

## Implementation

- The "decision records" section of `AGENTS.md` is the operational summary of this specification and links back to this file.
- `scripts/check-decisions.ts` is the check script that `## Impact` anticipates. It was added as the decision gate of [P0 scope, repository layout, and toolchain](261112_043033-p0-scope-and-toolchain.md#p0-scope); `bun run check:decisions` runs it, and `test/check-decisions.test.ts` tests it.
- The gate checks flat storage and file names, the fixed first three lines, the status line, the sections and their order, and that every `@decision` reference in code names an existing `accepted` decision and, when an anchor is given, a heading with that GitHub-style anchor.
