# Decision: Firmware keeps the import.meta paths of its sources

Status: accepted

## Background

- A device runs from its firmware, a bundle in `.rack/firmware/`, as [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build) decides. So `import.meta.url`, `dir`, `dirname`, `path`, and `filename` in a device file name the bundle, not the device file.
- A device that reads a file next to its source, such as `new URL("./template.html", import.meta.url)`, looks in `.rack/firmware/` and finds nothing. No document says so, and the same file works when it runs unbundled, such as in a test that imports it.
- Under `rack dev`, an edited manifest had the same problem, since `rack dev` imports it again from a bundle: a manifest that read a file next to it failed to reload. Commit 64991df fixed it for the manifest, with a build plugin that gives each file of the bundle the `import.meta` paths of its own source.
- Issue #15 asks for the same for devices.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - maintainability, since a device file means what it says wherever it runs: unbundled, as firmware, and on the bench;
  - reliability, since a device finds the files it ships with after every swap and reset.

## Decision

- Every build of firmware gives each file of the bundle the `import.meta` paths of its own source: `url`, `path`, `filename`, `dir`, and `dirname`. Helpers that the bundle takes in keep their own paths too.
- It is the plugin that 64991df wrote for an edited manifest, which moves into the firmware build, so devices, the bench, and `rack dev`'s manifests share it.
- It rewrites those member accesses in the source text: the words `import.meta.url` in a string or a comment change too, and `import.meta` used whole, such as when destructured, keeps the bundle's. The documentation says so.
- The documentation of devices says that a device reads a file next to its source with `import.meta`.

### Failure modes

| Failure | Outcome |
|---|---|
| A device used `import.meta.dir` to find its bundle | it now finds its source's directory; no device of rack42u or of its examples does |
| The app moves to another directory | the firmware of every file that uses those paths gets another hash, and the next reload replaces it, as after an edit |
| A file of the bundle is not JavaScript or TypeScript | the plugin leaves it alone, as Bun loads it |

### Tests

- A device that reads a file next to its source, and reports its `import.meta` paths, finds the file and reports its source's paths on the bench, in a rack, and after a hot swap.
- A helper in a subdirectory, which the device imports, reports its own paths.

## Alternatives

- **Documenting the limit,** with devices that name their files from `ctx.baseDir` or their configuration. Simpler, but a device file would mean one thing unbundled and another as firmware.
- **The source's path through the API,** such as `ctx.source`. It adds a member that `import.meta` already holds, and helpers wouldn't get their own.

## Impact

- Gains: a device file's `import.meta` names it, unbundled, as firmware, and on the bench.
- Costs: the firmware of a file that uses those paths depends on where the app lies, and the build reads each source file through the plugin.
- Follow-up: none.

## Confirmation

- The user approved this change on 2026-11-19, as the Agent's report put it: "A device file's `import.meta` points at its firmware bundle, not its source, so a device can't read a file next to its source. The `rack dev` fix only covered manifests. Giving device firmware the same treatment would change what firmware does, so it needs a decision." The user's words: "All approved — handle them in order."
