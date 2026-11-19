# Decision: A README that explains rack42u, and complete documentation that tests hold to the code

Status: accepted

## Background

- `README.md` is the only user documentation. It has 928 lines:
  - It opens with a paragraph on what rack42u is, a status line by phase, P0 to P3, and the requirements.
  - The example app of the repository follows, and then a section for each capability, in the order the capabilities were built: connectors, devices, binary data, streams, listeners, manifests, scanned racks, running a rack, swaps, faults, update safety, overload, management, the bench, the standard devices, error codes, and Windows.
  - Its files build a small app, which `test/readme.test.ts` extracts and runs, with rack42u linked into a temporary directory.
- What it lacks:
  - which problem rack42u solves, and how it solves it, as a whole;
  - why it is built this way, which only the 37 decision records under `.agents/decisions/` say, written for maintainers and agents;
  - how an app outside the repository depends on rack42u and starts out, since no section says it and no test does it;
  - a reference that lists every export, option, bound, and code. Two exports of `rack42u/bench`, `probeDevice` and `stubDevice`, aren't in it at all.
- `docs/` doesn't exist. `AGENTS.md` reserves it for user documentation, and [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#documentation) requires American English there.
- The global rules require a test for every capability that documentation presents as supported, through the path users take, and that the test points back at the document.
- On 2026-11-19, the user set the next steps:
  - "Polishing the README may be more important: what problem it solves, how to do it, why it's done this way, and how to use it, so people can understand it from the very beginning. Also, the rack42u documentation needs to be as complete as possible."
  - "After the README and documentation are improved, write a skill for the rack42u project, choose some typical simple applications, and then have an independent Agent use rack42u to develop them. Record the problems encountered during that process, file them as issues (the issue templates need to be written first), and then solve and optimize them together."
  - "When I said record issues, I mean filing issues on the GitHub repository."
- So the documentation is what the independent agent will learn rack42u from, and what it lacks will come back as issues.
- Apps depend on rack42u through git until the first formal release, and Bun 1.4.4 installs it as a git dependency from a local clone, as [Informal versions until the first release, and the Bun versions rack42u follows](261119_054816-versions-and-bun.md#informal-versions) records. A test can therefore install rack42u the way an app does, without access to GitHub.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - maintainability, since a builder understands each part from its own document, and a reader learns why before deciding to change it;
  - observability, since everything the rack reports is described in one place;
  - extensibility, since builders add devices and connectors from the documentation alone.

## Decision

### The README

The README is the front page. A reader who knows nothing of rack42u learns from it, in this order:

1. **What rack42u is**, in a paragraph.
2. **The problem it solves**: a long-running Bun program whose parts must change, fail, and recover on their own, and where one Bun process falls short of that, such as module reloads that keep old code, an exception that ends the whole process, and work that nothing bounds or watches.
3. **How it solves it**: the rack, devices in Workers, connectors, the backplane, firmware, swaps, and supervision, with a diagram.
4. **Why it is built this way**: the goals in their order, and the main choices with the reason for each, which `docs/design.md` explains in full.
5. **A quick start**: the example app of the repository, and the way to an app of your own.
6. **Status**: what works, what isn't built yet, and that versions are informal until the first formal release.
7. **The documentation**: a map of `docs/`.
8. Requirements, development, and the license.

The reference material of today's README moves to `docs/`, and none of it is dropped.

### The documentation

```text
docs/
  README.md             the map, and the order to read in
  getting-started.md    an app of your own, outside this repository: install, connectors, devices,
                        a rack, running it, testing a device, and a hot reload
  concepts.md           how a rack works: slots, devices, connectors, the backplane, firmware,
                        the lifecycle, swaps, and faults
  design.md             why rack42u is built this way: the goals, the main choices, what each costs,
                        and the limits that remain
  guides/               how to do one thing, such as writing devices, serving HTTP, or operating a rack
  reference/
    api.md              every export of rack42u, rack42u/std, and rack42u/bench, types included
    cli.md              every command, flag, exit code, and environment variable of rack
    errors.md           every error code, and what raises it
    limits.md           every bound, timeout, and default
    reports.md          status(), metrics(), history(), and the log's entries
```

- The guides start as the README's sections today, grouped by task: devices, connectors, binary data and streams, listeners, racks and plans, updates, faults and overload, running a rack, managing it, testing, the HTTP panel, and storage. They may split or merge as the writing shows; `docs/README.md` lists them.
- "Complete" means that every export, option, default, bound, error code, command, flag, report, and failure mode of rack42u is documented, with its limits.

### Writing

- The documentation is for builders who haven't read the code or the decisions, people and agents alike.
- It says what works, in the present tense, with its limits. It mentions no phases or plans, except in the README's status, and no decision records, except where `design.md` points to them for the full reasoning.
- One topic lives in one place, and the other documents link to it.
- Code identifiers and the terms of the glossary in `AGENTS.md` are used as they are.
- A change to behavior updates the documentation, and the tests that hold it, in the same change.

### Tests that hold the documentation

- **Apps run as written.** Every code block whose first line is `// <path>` belongs to an app that a test assembles from the document and runs, as `test/readme.test.ts` does today.
  - The app of `getting-started.md` is installed as the guide says: as a git dependency, from a repository that holds the files under test, and run with its commands, `rack start`, `rack dev`, and `bun test`.
  - If Bun can't install a git dependency from a local repository on a system, the test there installs the same files another way, and says why.
- **The reference matches the code.** Tests compare it with what the code lists, in both directions, so that nothing is missing or stale:
  - the exports of the three entry points, types included, with `reference/api.md`;
  - the `RACK_` error codes in `src/`, and the codes of the standard devices, with `reference/errors.md`;
  - the commands and flags of `rack`, from `src/cli.ts`, with `reference/cli.md`.
- **Sections name their tests.** A test that confirms what a section says names the section in a comment, as `@doc docs/guides/devices.md#state-handover`, the way tests name decisions with `@decision`.
- **A gate.** `scripts/check-docs.ts`, run by `bun run check:docs` and by `bun run check`, with tests of its own, fails:
  - when a `@doc` reference names a document or a heading that doesn't exist;
  - when a section of a guide or of the reference has no test that names it, unless the section begins with `<!-- no claims: <reason> -->`;
  - when a relative link or an anchor in `README.md` or `docs/` leads nowhere.
- The README, `docs/README.md`, `concepts.md`, and `design.md` explain and summarize. Each claim they make links to the section of a guide or of the reference that holds it, and the tests of that section confirm it.

### Order of the work

1. The gate, its tests, and the map of `docs/`.
2. The README's sections moved into the guides and the reference, with the tests that confirm them naming their new sections.
3. What is missing: the README's front page, `getting-started.md` with its test, `concepts.md`, `design.md`, and the reference, completed until the gate and its tests pass.

Each step is a change of its own.

### What comes next

- Once the documentation is done, a decision on the skill for rack42u, the trial apps, and the issue templates comes next. In it, an independent agent builds the trial apps from the skill and the documentation alone, and what it runs into is filed as issues on the GitHub repository, from the templates, for the user and the Agent to solve.

## Alternatives

- **Keep everything in the README and add what is missing:** one file to search, but at 928 lines it is already long. A reader who knows nothing would have to find the start among the reference, and the problem, the approach, and the reasons would make it longer still.
- **Generate the API reference from the JSDoc, with a tool such as TypeDoc:** it would be complete by construction, but it adds a dependency and a build step, and it renders types and signatures, not the rules around them. The JSDoc stays the reference in editors, and a test holds the written reference to the exports.
- **A documentation site, built by a static site generator:** it would add navigation and search, but needs a build and hosting, which a private repository makes awkward. Markdown in the repository reads on GitHub, in an editor, and by an agent.
- **Test only the code in the documentation, and leave the prose to review:** fewer comments in the tests, but nothing would show a section whose claims lost their test, which the global rules count as a defect.
- **Point the sections at decisions instead of tests:** a decision says what was meant, not that the behavior works.

## Impact

- The README becomes short, and its reference moves to `docs/`. Links into its sections from elsewhere, such as `examples/net-tool/README.md`, move with them.
- `test/readme.test.ts` follows the app it runs into the document that holds it, and the README's quick start keeps a test.
- Every section of the guides and the reference needs a test that names it. Where a section has none, writing one either confirms the section or finds a claim that no test confirms, which is a defect: the test is added, or the claim removed.
- Each change to behavior now also updates its sections of the documentation and the references of its tests, and the gate fails when they fall out of step.
- The trial apps will show what the documentation still lacks, from the view of a reader who knows nothing.
- How the accepted decisions this one affects are handled once it is accepted:
  - [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#documentation): American English for `README.md` and `docs/` stands, and this decision gives `docs/` its layout. It stays as it is, with this note.
- `AGENTS.md`, once it is accepted:
  - The repository structure gains `docs/` and `scripts/check-docs.ts`, and the line that `docs/` doesn't exist yet goes.
  - The commands gain `bun run check:docs`.
  - Step 6 of the workflow names the documentation in `README.md` and `docs/`, and the `@doc` references of its tests.
- Follow-up: the decision on the skill, the trial apps, and the issue templates, once the documentation is done.

## Implementation

- The documentation gate: `checkDocs` in `scripts/check-docs.ts`, run by `bun run check:docs` and by `bun run check`, and tested in `test/check-docs.test.ts`.
  - It reads `@doc` references from the code files under `test/`, and counts a section as one heading from `##` down.
  - It also checks that `docs/README.md` links to every other document under `docs/`, the map that [The documentation](#the-documentation) asks for.
- `scripts/markdown.ts` holds the headings and anchors that the decision gate and the documentation gate both read.
- `docs/README.md` is the map of `docs/`.
- The README's sections moved into the guides, `connectors.md`, `devices.md`, `data.md`, `listeners.md`, `racks.md`, `running.md`, `updates.md`, `faults.md`, `managing.md`, `testing.md`, `storage.md`, and `http.md` under `docs/guides/`, and into the reference, `api.md`, `cli.md`, `errors.md`, and `reports.md` under `docs/reference/`.
  - `test/guides.test.ts`, which was `test/readme.test.ts`, runs the greeter app that the guides build across their documents.
  - Tests name the sections they confirm with `@doc`, in place of the `README.md:` that began their names.
  - "Other sockets" in `listeners.md` said that a device's own sockets close with its instance, which no test confirmed; a test in `test/listeners.test.ts` now does, with the fixture device `raw-socket`.

## Confirmation

- The user accepted this decision on 2026-11-19, together with the two other decisions drafted that day, after reviewing them: "Approved, all of them. Get to work."
