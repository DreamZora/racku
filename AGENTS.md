# AGENTS.md

rack42u is a 42U rack-style component framework built on Bun, made of a rack runtime and a set of standard base components. The design requires every device to support hot swap and hot reload while running.

This file defines the project background, architectural constraints, and working method. Commit conventions, tags, and general rules such as "a documented capability must have a test" come from the global `~/.fcode/AGENTS.md`; they are not repeated here.

## Current state

- P0 is complete as scoped by [P0 scope, repository layout, and toolchain on Bun 1.4.4](.agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md): the `rack42u` and `rack42u/std` entry points, the rack runtime with the `sled` form, firmware builds, swaps, crash resets, the HTTP panel, the `memkv` and `sqlite` standard devices, the `rack start` and `rack dev` commands, the example app `examples/shop-api`, and `README.md`.
- Details that the earlier decisions left open are fixed by [P0 standard connectors, rack handle shapes, and test fixtures](.agents/decisions/261115_222025-p0-api-details.md).
- Calls and events between devices travel on direct links between Workers, as [Backplane protocol with direct links between devices](.agents/decisions/261116_024226-backplane-links.md) decides; the main thread sets up the links and routes only calls from outside the rack. `rack.metrics()` reads the call and event counters each Worker keeps, as [Call and event metrics](.agents/decisions/261116_035534-call-metrics.md) decides.
- Calls and results can move `ArrayBuffer`s instead of copying them, and `SharedArrayBuffer`s are shared under rules the README states, as [Transfer and shared buffers for binary data](.agents/decisions/261116_213839-transfer-and-shared-buffers.md) decides.
- The four accepted decisions of P1 are implemented:
  - [Automatic assembly from scanned device files](.agents/decisions/261116_233919-automatic-assembly.md): a manifest can name directories of device files, and the rack plans shared instances, `own` copies, wiring, and slots, and keeps the plan in a plan file.
  - [Hot swaps, cold swaps, and restarts](.agents/decisions/261116_233956-cold-swaps-and-restarts.md): cold swaps, restarts, group replacements for contract changes, and changed plans and edited manifests applied to a running rack.
  - [Fallback, rollback, and update history](.agents/decisions/261117_005743-fallback-rollback-and-history.md): probation with passive fallback, `rollback()`, a bounded `history()`, and deleting firmware that nothing needs.
  - [Management endpoint and the rack ctl command](.agents/decisions/261117_005821-management-endpoint.md): `rack ctl` over a Unix socket on Linux and macOS, and over token-protected loopback TCP on Windows or with `--control-port`.
- The accepted decisions of P2 are implemented:
  - [Design goals and principles](.agents/decisions/261117_062916-design-principles.md): the goals and practices that [Design principles](#design-principles) summarizes.
  - [Watchdog](.agents/decisions/261117_062959-watchdog.md): an event-loop watchdog for every device, and watchdogs that devices feed from their work loops.
  - [Bounded backlogs instead of a breaker and thermal](.agents/decisions/261117_063228-bounded-backlogs.md): one bound on the calls and events waiting between devices, `RACK_OVERLOADED`, and no work on expired calls.
  - [Ending instances and stuck threads](.agents/decisions/261117_185131-ending-instances.md): every stop waits for the device's thread, a thread stuck in native code keeps its device from starting again, and a failed hot swap reactivates or resets the old instance.
  - [Counters for calls from outside the rack](.agents/decisions/261117_185225-outside-call-metrics.md): `metrics().outside` counts the calls through `call()` and the panel by port and member, including the ones the rack answers itself.
- Windows is a supported platform, as [Windows as a supported platform](.agents/decisions/261118_015204-windows.md) decides: what the README describes works and is tested there, apart from the differences its "Windows" section states.
- [Continuous integration with Windows checked](.agents/decisions/261118_015210-ci-with-windows.md), which replaces the earlier CI decisions, runs the checks on Linux and the tests on macOS and Windows, for pushes to `main` and manual runs. A failure on any of the three fails the run.
- P3 is under way on `feat/p3`. Its first five accepted decisions are implemented:
  - [Byte streams in calls between devices](.agents/decisions/261118_071155-backplane-streams.md): calls carry `ReadableStream`s of bytes, with flow control by credit.
  - [Panels as devices, with listeners that survive swaps](.agents/decisions/261118_070617-panels-as-devices.md): devices open HTTP and WebSocket listeners with `ctx.serve`, which the rack hands over across swaps, and the rack's main thread holds no panel.
  - [The standard HTTP panel device, with WebSocket and TLS](.agents/decisions/261118_071513-http-panel-device.md): `httpPanel()` in `rack42u/std`, the `http/v2` connector, needs that a device computes from its configuration with `patched()`, and certificates that load without a restart, in place of the manifest's `panel` section.
  - [A configurable stream threshold, with bodies sent whole read by Bun](.agents/decisions/261118_165318-stream-threshold.md): `streamThreshold` in the panel and in `httpHandler`, 256 KiB by default, decides which bodies go whole and which stream, and a request body sent whole must arrive within `idleTimeout`.
  - [Panel responses no slower than the main-thread panel](.agents/decisions/261118_195832-faster-panel-responses.md): `httpHandler`'s default `streamThreshold` of 16 MiB, and response bodies of 14 KiB or more handed to Bun as streams, chunked.
- P3's next three accepted decisions are not implemented yet, and go in this order:
  - [A test bench for one device](.agents/decisions/261118_173457-device-test-bench.md): `rack42u/bench`, which runs one device in a rack of its own, with stubs for its needs that the test implements.
  - [Running a rack under another program](.agents/decisions/261118_173838-running-under-another-program.md): `--stop-on-stdin-close` and `--log json` for `rack start` and `rack dev`.
  - [examples/net-tool, a TCP and UDP tool on Tauri 2 and Quasar](.agents/decisions/261118_173845-net-tool-example.md): the first project on rack42u, run from source.
- The minimum Bun version is 1.4.4: Bun 1.3.13 crashes when a Worker that used a transferred `MessagePort` ends, and the backplane's data channel is such a port.
- Of what the P0 decision lists as not in P0, P1 covers editing the manifest of a running rack and replacing several devices together for a contract change, as [Hot swaps, cold swaps, and restarts](.agents/decisions/261116_233956-cold-swaps-and-restarts.md) decides. P2 adds the watchdog, and replaces the breaker and thermal with bounded backlogs. P3's decisions cover the WebSocket panel. Everything else on that list, such as the `inline` and `chassis` forms, still needs its own decision before work starts.
- Do not assume that a module, command, or directory exists; trust the actual repository content.

## Project positioning

- The framework provides only the rack runtime and standard base components. Which devices go into the rack, and whether they form a backend, a frontend, a desktop application, or something else, is up to the builder ([Project scope](.agents/decisions/261112_035941-project-scope.md)).
- The core contains no logic for a specific application type; such capability can only be a device.
- The technology stack is Bun, with TypeScript and ESM. Bun is the runtime, the package manager, and the test runner, and its built-in capabilities are preferred.
- The license is MIT ([License](.agents/decisions/261112_035940-mit-license.md)). Every new dependency must be MIT-compatible.

## Design principles

Rack terms make the system easy to understand; they don't prescribe behavior. Features come from the goals and practices below, as [Design goals and principles](.agents/decisions/261117_062916-design-principles.md) decides.

**Goals**, in this order when they conflict:

1. **Reliability**: the rack keeps serving what it can. Every fault is detected, contained to its device, reported, and recovered from along a defined path.
2. **Maintainability**: each part can be understood, changed, and tested on its own.
3. **Observability**: an operator can see what the rack is doing, what it did on its own, and why.
4. **Extensibility**: builders add capabilities as devices and connectors, without changing the core.

**Simplicity**, after the Linux philosophy:

- One mechanism does one thing and composes with the others.
- The rack provides mechanisms; devices and manifests set policy.
- Reuse an existing path before adding a new one.
- Keep state and interfaces as plain data a person can read: text files, JSON, structured logs, and error codes.
- Keep options few, each with a safe, documented default.

**Reliability**, after industrial, automotive, and aerospace practice:

- Bound every queue, backlog, retry, record, file, and wait.
- Give every wait a timeout, and every timeout a defined outcome.
- Contain faults: a fault in one device must not stop the others or the rack.
- Fail fast and explicitly, with a structured code. Never fail silently, hang, or retry without limit.
- Supervise what can hang or crash, within limits. The service manager supervises the rack process.
- Keep a known-good state to return to, and make every change reversible.
- Prefer fixed, declared limits and explicit states to adaptive heuristics, so behavior under faults and overload stays predictable and testable.
- Validate data at every boundary.
- Test the failure paths, such as crashes, hangs, timeouts, overload, and bad updates, not only the paths that work.

**Within JavaScript's limits**: garbage collection, one event loop per thread, and third-party code rule out the timing guarantees of C on a real-time system. Aim for every known failure mode to have a detection, a bound, a recovery, and a test, and document the limits that remain instead of implying guarantees.

**Borrowed concepts**: adopt a physical concept only when it serves a goal through a mechanism that suits software; reshape or drop the rest. A decision for a feature states the goals it serves, the failure modes it handles, its bounds, how an operator observes it, and how tests exercise its failures.

## Architecture overview

See [Automatic assembly from scanned device files](.agents/decisions/261116_233919-automatic-assembly.md), which comes first where they differ, then [Rack runtime architecture](.agents/decisions/261112_035942-rack-architecture.md) and [Hot swap and hot reload](.agents/decisions/261112_035943-hot-swap.md) for details. The devices in the diagram below are examples only.

```text
rack (one process)
├── main thread: backplane · slot state machine · power sequencing · management bus
│     never imports device code; devices are mounted by path
├── U12 http-panel form=sled  -> a panel: listens with ctx.serve, calls the devices below it
├── U10 orders  form=sled     -> one Worker per device (default)
├── U5  memkv   form=inline   -> main thread, still called through the backplane
└── U3  sqlite  form=chassis  -> child process
```

- **Basic composition**: the rack is one process, devices are hot-swappable modules, the backplane is the only communication channel between devices, and panels are devices that hold the external ports, as [Panels as devices, with listeners that survive swaps](.agents/decisions/261118_070617-panels-as-devices.md) decides.
- **Gravity rule**: a device may depend only on devices in lower slots. On cold start, devices power on from the bottom up; on shutdown, they power off from the top down. In a scanned rack, the plan places every device above what it needs, and a cycle fails at startup.
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
| Link | `link` | A `MessageChannel` the backplane sets up from one need of a consumer instance to a provider port; calls and events between devices travel on it |
| Patch | `patch` | An explicit connection that picks the target when the choice is ambiguous |
| Panel | `panel` | A device that owns external connections, such as the standard HTTP panel, and passes the work to other devices through the backplane |
| Listener | `listener` | An HTTP server, WebSocket included, that a device opens with `ctx.serve`, and that the rack hands over across swaps |
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
5. Panels are devices. The rack's main thread holds no external connections except the management endpoint; devices open listeners with `ctx.serve`, which the rack hands over across swaps.
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
   - CI runs only for pushes to `main` and manual runs, so `bun run check` before each commit is what checks a branch. A change to platform behavior, such as paths, sockets, signals, or file modes, needs a manual run on its branch before it merges; ask the user to start one.
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
| Run the example app | `bun src/cli.ts start examples/shop-api/rack.ts` |
| Run the example app with hot reload | `bun src/cli.ts dev examples/shop-api/rack.ts` |

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
- Do not modify or delete tests just to make them pass. A test may change only when an `accepted` decision covers the behavior change, or when it is clear that the test itself is wrong; the commit then says what was wrong and how that was shown. See [When a test may change](.agents/decisions/261118_011457-changing-tests.md).
- Do not commit files unrelated to the task, such as temporary probe scripts, editor configuration, or build output.

## Repository structure

```text
AGENTS.md            this file; CLAUDE.md is a symlink to it
README.md            user-facing documentation; test/readme.test.ts runs its app
LICENSE              MIT
package.json         manifest, exports, bin, and scripts
tsconfig.json        TypeScript configuration
biome.json           formatter and linter configuration
bun.lock             lockfile
.gitattributes       LF line endings in every checkout, Windows included
src/                 framework source
  index.ts           entry point of rack42u
  cli.ts             the rack command (start, dev, plan, ctl); dev.ts holds the file watcher
  rack.ts            assembly, power sequencing, swaps, resets, and the rack handle
  backplane.ts       links between instances, holds and switches, and calls from outside the rack
  instance.ts        the main thread's handle on one device Worker
  worker.ts          the Worker host: firmware, hooks, link traffic, and counters
  metrics.ts         the counter shapes rack.metrics() returns
  plan.ts            the planner of scanned racks, and the plan file
  control.ts         the management endpoint that rack ctl talks to
  transfer.ts        checks and moves the buffers that calls and results transfer
  streams.ts         both ends of the byte streams in calls, on a link or the data channel
  listeners.ts       the listeners that devices open with ctx.serve, in the Worker host
  firmware.ts        per-device Bun.build with content hashes
  std/               entry point of rack42u/std and the standard devices
    http.ts          the http/v2 connector and httpHandler
    http-panel.ts    the standard HTTP panel device
test/                bun:test tests, named *.test.ts
  fixtures/          test devices, connectors, and helpers; no tests
examples/shop-api/   the example app
scripts/             project scripts; check-decisions.ts is the decision gate
.github/workflows/   check.yml, the CI jobs on Linux, macOS, and Windows
.agents/decisions/   decision records, stored flat as <YYMMDD>_<hhmmss>-<topic>.md
```

- `docs/` does not exist yet; it will hold user-facing project documentation only.
- The code layout for P0 is fixed by [P0 scope, repository layout, and toolchain on Bun 1.4.4](.agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md); `test/fixtures/` by [P0 standard connectors, rack handle shapes, and test fixtures](.agents/decisions/261115_222025-p0-api-details.md#test-fixtures).
- Device files, including `src/std/memkv.ts`, `src/std/sqlite.ts`, and `src/std/http-panel.ts`, import the framework as `rack42u` and `rack42u/std`, never by relative path, so firmware keeps it external.

## Maintaining this file

- `CLAUDE.md` is a symlink to `AGENTS.md`; edit only `AGENTS.md`.
- Keep this file to rules and navigation; rationale lives in decisions, and this file only links to them.
- When a rule tied to a decision changes, write or update the decision first, then change this file.
- When the architecture, process, or directory layout changes, update this file in the same change.
