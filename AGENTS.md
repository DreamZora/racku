# AGENTS.md

rack42u is a 42U rack-style component framework built on Bun, made of a rack runtime and a set of standard base components. The design requires every device to support hot swap and hot reload while running.

This file defines the project background, architectural constraints, and working method. Commit conventions, tags, and general rules such as "a documented capability must have a test" come from the global `~/.fcode/AGENTS.md`; they are not repeated here.

## Current state

- The P0 scaffold is in place: `package.json`, `tsconfig.json`, `biome.json`, `bun.lock`, the first runtime modules under `src/` (`schema.ts`, `connector.ts`, `errors.ts`) with their tests under `test/`, and the decision gate `scripts/check-decisions.ts`.
- P0 still lacks the package entry points, the rack runtime, the CLI, the panel, the standard devices, the example app, and `README.md`; [P0 scope, repository layout, and toolchain on Bun 1.4.4](.agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md) fixes the scope and the layout.
- Do not assume that a module, command, or directory exists; trust the actual repository content.

## Project positioning

- The framework provides only the rack runtime and standard base components. Which devices go into the rack, and whether they form a backend, a frontend, a desktop application, or something else, is up to the builder ([Project scope](.agents/decisions/261112_035941-project-scope.md)).
- The core contains no logic for a specific application type; such capability can only be a device.
- The technology stack is Bun, with TypeScript and ESM. Bun is the runtime, the package manager, and the test runner, and its built-in capabilities are preferred.
- The license is MIT ([License](.agents/decisions/261112_035940-mit-license.md)). Every new dependency must be MIT-compatible.

## Architecture overview

See [Rack runtime architecture](.agents/decisions/261112_035942-rack-architecture.md) and [Hot swap and hot reload](.agents/decisions/261112_035943-hot-swap.md) for details. The devices in the diagram below are examples only.

```text
rack (one process)
├── main thread: backplane · slot state machine · power sequencing · panel (Bun.serve) · management bus
│     never imports device code; devices are mounted by path
├── U10 orders  form=sled     -> one Worker per device (default)
├── U5  memkv   form=inline   -> main thread, still called through the backplane
└── U3  sqlite  form=chassis  -> child process
```

- **Basic composition**: the rack is one process, devices are hot-swappable modules, the backplane is the only communication channel between devices, and the panel holds the external ports owned by the rack.
- **Gravity rule**: a device may depend only on devices in lower slots. On cold start, devices power on from the bottom up; on shutdown, they power off from the top down.
- **Three buses**: the power bus carries lifecycle, the data bus carries business calls, and the management bus carries out-of-band commands.
- **Firmware**: each device is built into one bundle with a content hash, and the hash is the version, so only devices whose hash changed are replaced.
- **Swap**: insertion, removal, replacement, and hot reload all use the same process. Requests make before break, background tasks break before make, and any failing step rolls back to the old instance.

### Terminology

Use the English identifiers in the table below consistently in code. Do not call a device a plugin, a module, a component, or a service.

| Term | Code identifier | Meaning |
|---|---|---|
| Rack | `rack` | One process and one deployment unit; 42U by default, configurable |
| Slot | `slot` | A position in the rack, numbered from 1 at the bottom up |
| Device | `device` | A hot-swappable module that occupies one or more U |
| Connector | `connector` | A contract with a name, a version, and schemas, for example `kv/v1` |
| Port | `port` | One instance of a connector on a device, addressed as `<device>.<port>` |
| Backplane | `backplane` | The only communication channel between devices |
| Patch | `patch` | An explicit connection that picks the target when the choice is ambiguous |
| Panel | `panel` | An external port owned by the rack, such as HTTP or WebSocket |
| Firmware | `firmware` | The hashed bundle a device is packaged into |
| FRU data | `fru` | The model, height, and `needs`/`provides` that a loaded device reports |
| Form | `form` | `sled` (Worker), `inline` (main thread), `chassis` (child process) |
| Swap | `swap` | The process shared by insertion, removal, replacement, and hot reload |

### Hard constraints

These constraints come from the two architecture decisions above. Breaking any one of them breaks hot swap, so changing one requires a new `accepted` decision.

1. Devices interact only through backplane addresses; they never import each other's code and never hold each other's instances.
2. The rack main thread never imports device code; devices are mounted by path.
3. Ports carry only structured-cloneable data, errors must be serializable, and timeouts and cancellation must cross the backplane.
4. Background tasks start only after `activate` and stop in `deactivate`; an `inline` device binds its resources to `ctx.signal`.
5. The panel owns external connections; devices provide only the handling logic.
6. A device may depend only on devices in lower slots.
7. Hot reload goes through the swap process only; `bun --hot` or reloading modules in-process is not a substitute.
8. The core contains no logic for a specific application type.

## Decision records

Read [Decision records](.agents/decisions/261112_035939-decision-records.md) before writing a decision. Summary:

- **Location**: `.agents/decisions/`, stored flat. File names are `<YYMMDD>_<hhmmss>-<topic>.md`, with the local time of the first recording.
- **Division of labor with `docs/`**: `docs/` holds only user-facing project documentation, never decision records.
- **Format**: the first two lines are `# Decision: <title>` and `Status: <status>`; the body is `## Background`, `## Decision`, `## Alternatives`, `## Impact`, in that order.
- **Status**: `proposed`, `accepted`, `superseded — replaced by [...](...)`, `rejected — <reason>`.
- **Who accepts**: an agent can only draft `proposed`; changing a decision to `accepted` requires explicit user confirmation.
  - Exception: when the user explicitly authorizes an agent to decide on its own, the agent may mark its own decision `accepted` and record the authorization source and date in `## Confirmation`.
  - During such authorization, hand hard decisions to the review model the user designates (currently Fable) first.
  - Authorization does not carry over to later sessions.
- **Editing rules**: the content of an `accepted` decision is never rewritten; write a new decision to replace it. Only implementation facts such as paths and symbol names follow the code.
- **When a decision is required**: architecture, public API, connectors, backplane protocol, data formats, runtime dependencies, toolchain, repository layout, process, breaking changes, security rules, or any departure from an existing decision. Local mechanical edits do not need one.
- **Code reference format**: `@decision .agents/decisions/<file>[#anchor]`.
  - A module that implements a decision references it in the file-header JSDoc.
  - A construction that only makes sense because of a decision references it in a line comment at that spot.
  - A test that pins a decision's behavior references the decision too.
- **Reference requirements**: a referenced decision must exist and be `accepted`. When a decision is superseded, update every reference in the same change.
- **Check**: `bun run check:decisions` enforces the location, file name, format, status, and code reference rules above, including that a referenced `#anchor` exists.

## Development workflow

1. Read this file and the relevant decisions (`ls .agents/decisions`, then grep by topic).
2. If the task requires a decision, or conflicts with an existing one, write a `proposed` decision first and stop until the user confirms. Do not write implementation code before that confirmation.
3. Implement only what `accepted` decisions cover, do not widen the scope along the way, and reference decisions in code as required.
4. Put tests and implementation in the same change, using `bun:test`. See the global rules for how documented capabilities map to tests.
5. Run the checks closest to the change first, then widen them with the scope; see [Commands](#commands). Report only commands that actually ran, with their results.
6. Finish by updating `## Implementation` in the affected decisions and the documentation they affect. Commits follow the global rules and list the relevant decisions in `Context:`.

## Commands

| Purpose | Command |
|---|---|
| Run all tests | `bun test` |
| Run one test file | `bun test test/connector.test.ts` |
| Run the tests whose names match a pattern | `bun test -t "<pattern>"` |
| Type check | `bun run typecheck` |
| Check formatting and lint rules | `bun run lint` |
| Apply formatting and safe lint fixes | `bun run format` |
| Check decision records and `@decision` references | `bun run check:decisions` |
| Run the type check, lint, decision gate, and tests in order | `bun run check` |

## Coding standards

- **Language**: code identifiers, comments, JSDoc, and every repository document, including this file and everything under `.agents/`, are in standard American English.
- **Types**: TypeScript runs with `strict`; no `any`, and when it is unavoidable, comment why.
- **Public API**: every exported symbol has JSDoc stating its parameters, return value, possible errors, and lifecycle constraints.
- **Comments**: state only the constraints and reasons a reader needs, never restate the code. Link to the decision when the reason is long.
- **Errors**: use structured errors with codes that survive the backplane; every empty `catch` explains why it is empty.
- **Dependencies**: a new runtime dependency needs a decision first; do not add a third-party package when Bun built-ins suffice.
- **Naming**: use the words in the glossary; do not invent synonyms.

## Prohibitions

- Do not introduce a new architecture, public API, connector, runtime dependency, directory, or toolchain without an `accepted` decision.
- Do not rewrite the content of an `accepted` decision, and do not change `proposed` to `accepted` without user confirmation or authorization.
- Do not import device code in the rack main thread, and do not let devices import each other or hold each other's instances.
- Do not modify or delete tests to make them pass. Tests may change only when an `accepted` decision covers the behavior change.
- Do not commit files unrelated to the task, such as temporary probe scripts, editor configuration, or build output.

## Repository structure

```text
AGENTS.md            this file; CLAUDE.md is a symlink to it
LICENSE              MIT
package.json         manifest, exports, bin, and scripts
tsconfig.json        TypeScript configuration
biome.json           formatter and linter configuration
bun.lock             lockfile
src/                 framework source; entry points are still being built
test/                bun:test tests, named *.test.ts
scripts/             project scripts; check-decisions.ts is the decision gate
.agents/decisions/   decision records, stored flat as <YYMMDD>_<hhmmss>-<topic>.md
```

- `docs/` does not exist yet; it will hold user-facing project documentation only.
- The code layout for P0 is fixed by [P0 scope, repository layout, and toolchain on Bun 1.4.4](.agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md).

## Maintaining this file

- `CLAUDE.md` is a symlink to `AGENTS.md`; edit only `AGENTS.md`.
- Keep this file to rules and navigation; rationale lives in decisions, and this file only links to them.
- When a rule tied to a decision changes, write or update the decision first, then change this file.
- When the architecture, process, or directory layout changes, update this file in the same change.
