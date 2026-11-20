# Decision: A rack in one executable, which runs devices from files beside it and falls back to the ones inside

Status: accepted

## Background

- [The main thread runs no devices, and what child processes, connected racks, and single executables must meet](261119_054850-main-thread-runs-no-devices.md#single-executables) sets what this decision must meet:
  - a rack app can be packaged into one executable, with its devices inside it;
  - the executable loads a device from a file outside it when there is one, and otherwise falls back to the device packaged inside it;
  - this decision settles when a device falls back, such as for a file that is missing, fails to build, or fails its probation, and how a device outside the executable resolves `rack42u`.
- The user's direction, on 2026-11-19: "Single-executable packaging needs to be supported, and it must be able to load devices outside the single executable as well as fall back to devices inside the packaged file." On 2026-11-20, the user chose single executables as the next work, before devices in child processes and connected racks.
- How a rack runs today:
  - At start, the rack builds each device file into firmware with `Bun.build`, in `.rack/firmware/` under the base directory. rack42u and the packages that the app declares stay out of the firmware, and resolve through the app's `node_modules`, as [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build) decides. An executable has no `node_modules`.
  - Each device runs in a Worker of its own, whose host is `src/worker.ts`. The host tells a device's `RackError` apart by `instanceof`, so firmware and host must share one copy of rack42u, as they do when both load it from `node_modules`. A device's other packages serve only its own firmware.
  - The main thread starts each Worker from a URL that it computes from its own `import.meta.url`, and rack42u's own devices, such as `httpPanel()`, name their files the same way.
  - At cold start, the firmware a device starts with is known-good, and a device falls back to known-good firmware when an instance on probation crashes, as [Fallback, rollback, and update history](261117_005743-fallback-rollback-and-history.md#known-good-firmware-and-probation) decides.
- `examples/net-tool` runs from source, with Bun installed. Its decision names a rack compiled with `bun build --compile`, as a sidecar of the Tauri shell, as the way to an installer, and leaves that to a decision of its own, in [its alternatives](261118_173845-net-tool-example.md#alternatives).
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since every device in an executable has a known-good firmware that no file on disk can change, which it runs when its outside file fails;
  - maintainability, since firmware inside the executable and outside it is built the same way, and an outside file is handled as an update;
  - observability, since the rack reports, for each device, whether it runs its packaged firmware or a file, and why;
  - extensibility, since an app ships as one file, and a device is replaced where the app runs, by a file, without a new executable.

## Evidence

Measured on 2026-11-20 with Bun 1.4.4 on Linux x64, with probe scripts outside the repository:

- Inside an executable from `bun build --compile`, `Bun.build` builds a file on disk, with plugins, and writes its output to disk.
- Bun keeps each entry point of the executable at its path from the entry points' common directory, with `.js` for `.ts`, under a root that the main module finds as `new URL(".", import.meta.url)`: `/$bunfs/root/` on Linux.
- A Worker starts from an entry point named by that path. When the entry point lies in a directory under the root, neither `new URL("./worker.ts", import.meta.url)` nor `"./worker.ts"`, in the module beside it, starts the Worker: in the executable, the `import.meta.url` of bundled code names the executable itself, at the root.
- In that Worker, `import()` loads firmware built on disk, and firmware packaged as an entry point, by URLs computed at run time.
- A `Bun.build` plugin that resolves a package's name to a module that re-exports what the Worker host put on `globalThis` gives firmware the host's copy: the error class that firmware on disk and packaged firmware threw was the host's, by `instanceof`, and the shared module ran once in the Worker.
- Firmware on disk imports a package packaged as an entry point by its path inside, such as `/$bunfs/root/pkg/index.js`, with its default and named exports.
- An executable is about 104 MiB, most of it Bun.

## Decision

### Compiling a rack

- `rack compile [manifest] [--outfile <file>] [--target <target>]` packages a rack into one executable.
  - It loads the manifest as `rack start` does, and builds the firmware of every device that the manifest mounts, rack42u's own devices included. For a scanned rack, those are the device files that its directories hold, and its plan file is packaged as it is.
  - With `bun build --compile`, it packages the manifest, the rack runtime and its Worker host, the firmware, and once each, the packages that the app's `package.json` declares and the firmware imports.
  - `--outfile` defaults to the rack's name, next to the manifest, with `.exe` for Windows. `--target` takes one of Bun's targets, such as `bun-windows-x64`, for an executable of another system; by default, the executable is for the system that compiles it.
  - It prints each packaged device with its firmware hash, and the executable's path and size.
- Firmware in an executable imports rack42u from its Worker host, which gives it the host's own copy, as the host's and the firmware's imports from `node_modules` share one copy under `rack start`. Packaged firmware bundles everything else it imports.
- The manifest runs when the executable starts, so it reads the environment then, as under `rack start`. A slot whose device the executable doesn't package fails the start with `RACK_MANIFEST`, which names the file.

### Running an executable

- The executable starts its rack as `rack start` starts the manifest: with the same flags, `--no-plan`, `--no-watchdog`, `--control-port`, `--log`, and `--stop-on-stdin-close`, the same signals, and the same exit codes. One flag is its own: `--base-dir <dir>`.
- `<executable> ctl <operation>` operates the rack that the executable runs for the same base directory, with the operations and flags of `rack ctl`.
- The base directory stands for the manifest's directory: the directory that `--base-dir` names, or by default the one that holds the executable.
  - Relative paths of the manifest and of devices' configuration resolve against it, and `.rack/` goes in it, as under `rack start`.
  - The `import.meta` paths of the manifest and of each device's files name their places under it, where their outside files would be, so a manifest or a device reads a file next to its source from there. A file that must be inside the executable is imported instead, such as `import routes from "./routes.json"`.
  - The rack itself writes in it only the firmware of outside files, and devices write where their configuration says, such as the database of `sqlite`.

### Devices from outside files

- Each device whose file lies in the manifest's directory, outside `node_modules`, has an outside file: the file at the same path under the base directory. rack42u's own devices, and devices from other packages, run only from their packaged firmware.
- When the rack starts, and on each `reload()` and `swap(name)`, a device runs its outside file when there is one, and its packaged firmware otherwise. A device whose outside file was removed returns to its packaged firmware at the next `reload()` or `swap(name)`.
- An outside file counts as an update of its packaged device: it goes through probation, its failures are reported as a swap's, and it falls back to the packaged firmware as an update falls back to known-good. At start, the rack starts the outside file's firmware directly, without starting the packaged firmware first.
- The rack builds an outside file inside the executable, into `.rack/firmware/` under the base directory, as `rack start` builds a device file. Its firmware imports rack42u from the Worker host, and the packages that the executable carries from the executable. Any other import resolves from the file's place, and its firmware bundles it.
- Outside files replace packaged devices; they add none. In a scanned rack, the directories that the executable scans hold the device files it packaged.

### Falling back

- In an executable, a device's packaged firmware is its first known-good firmware. A device that starts from an outside file starts on probation, unlike a device at cold start under `rack start`. Its outside firmware becomes known-good once it gets through probation, as after any update.
- A device runs its packaged firmware, and its slot reports `degraded` with the failure as its `error`, when its outside file:
  - fails to build: `RACK_SWAP_REJECTED`, with the build's messages, as a swap of the file reports;
  - fails to load, to boot, to be wired, or its `selfTest`, with the code of that failure;
  - crashes, or a watchdog bites, on probation, as [Passive fallback](261117_005743-fallback-rollback-and-history.md#passive-fallback) describes, including a group that a contract change replaced, which falls back together.
- A device whose outside file is missing runs its packaged firmware, online: that is no fallback.
- A device falls back at most once per update, a start included. When its packaged firmware fails too, the rules of `rack start` apply: a rack that can't start a device fails to start, and a device that crashes is reset, up to the crash limit.

### Failure modes

| Failure | Outcome |
|---|---|
| An outside file fails to build, such as for an import that resolves nowhere | The packaged firmware runs; the slot is `degraded`, with `RACK_SWAP_REJECTED` and the build's messages; the log warns. |
| The outside file's firmware fails to load, boot, be wired, or pass `selfTest` | The packaged firmware runs, `degraded`, with that failure's code. |
| It crashes, or a watchdog bites, on probation | The device falls back to its known-good firmware: the packaged one, or an outside one that got through probation earlier. |
| The packaged firmware fails | As under `rack start`. |
| The base directory can't be written | Building an outside file fails: the packaged firmware runs, `degraded`. |
| The manifest mounts a device that the executable doesn't package | The start fails with `RACK_MANIFEST`, which names the file. |
| An outside file changes while the rack runs | Nothing changes until `reload()` or `swap(name)`, as under `rack start`. |
| A rack already runs for the base directory | The executable refuses to start, as `rack start` does. |
| `rack compile` meets a device that fails to build | It fails with the build's messages, and writes no executable. |

### Bounds

| What | Bound |
|---|---|
| Builds of outside files | One per device at start, and at each `reload()` or `swap(name)`. |
| Fallbacks | At most one per update, a start included. |
| Probation | `probation`, 60 000 ms, as under `rack start`. |
| Firmware on disk | The firmware of outside files, in `.rack/firmware/`, deleted once nothing needs it, as under `rack start`. |
| The executable's size | About 104 MiB on Linux x64, most of it Bun, and the firmware. |
| A build | No timeout of its own, as under `rack start`. |

### Observation

- `status()` gains `packaged: true` for a device whose installed instance runs its packaged firmware, in an executable. `source` names the device's outside file under the base directory, whether or not it exists, so an operator knows where a replacement goes.
- The log says `<device> runs <file>` for each outside file at start, and warns `<device> runs its packaged firmware: <reason>` at each fallback.
- `history()` records each fallback with the cause `fallback`, as for any update.
- `rack compile` prints what it packaged, as above.

### Tests

- A fixture app is compiled once per run, and its executable runs on Linux, macOS, and Windows, in CI too:
  - Without outside files, every device is online and `packaged`, and the panel answers.
  - The manifest reads the environment at start, such as `PORT`.
  - A changed device file under the base directory runs: its answers change, and a `RackError` that it throws reaches the caller with its code.
  - An outside file that imports a package the executable carries runs. One that imports a package found nowhere falls back, with its build's messages.
  - An outside file that crashes on probation falls back to the packaged firmware, and `history()` records it.
  - Removing the file, then `ctl reload`, returns the device to its packaged firmware.
  - `ctl stop`, a signal, and `--stop-on-stdin-close` shut it down in order.
  - A device reads a file next to its source from the base directory.
- `rack compile` of a rack with a device that fails to build fails, and writes no file. With `--target` for another system, it writes an executable for that system, which the test doesn't run.

## Alternatives

- **Unpacking at start.** The executable would write rack42u, the packages, and the firmware under `.rack/`, and run as `rack start` does. That reuses more of today's path, but the known-good firmware would lie on disk, where it can be changed, and the executable would write its runtime at each start, into a base directory that it must be able to write.
- **Prebuilt firmware as the outside files.** Nothing would be built where the app runs, but every change would need rack42u's tools, and the requirement names a file that fails to build.
- **Outside files that add devices.** A device without packaged firmware has nothing to fall back to.
- **Firmware that bundles rack42u.** A Worker would hold two copies, and a device's `RackError` would reach callers as `RACK_DEVICE_FAULT`.
- **Freezing the manifest at compile time.** The environment where the executable runs, such as a port or a token, would be lost; net-tool's shell passes its token that way.
- **The working directory as the default base directory.** The program that starts the executable, such as a service manager or a Tauri shell, may set any working directory; the executable's own directory doesn't change.
- **An option to run packaged devices only.** The requirement doesn't call for it; it can be added when an app needs it.
- **`bun build --compile` by hand.** An app would have to know rack42u's Worker host, the files of rack42u's own devices, and how firmware finds rack42u.

## Impact

- Gains: an app ships as one file, without Bun or `node_modules`; every device in it has a known-good firmware; a device is replaced where the app runs by a file beside the executable.
- Costs:
  - about 104 MiB per executable, and one compile per system;
  - outside files run with the rights of the executable: whoever can write the base directory can run code in the rack, as whoever can write an app's files can under `rack start`;
  - a command, a flag, and a field of `status()`.
- Inside rack42u: the main thread finds the Worker host, and the files of rack42u's own devices, inside an executable; firmware builds gain a plugin for rack42u and the carried packages; the `rack` command gains `compile`, and executables a command line.
- [Fallback, rollback, and update history](261117_005743-fallback-rollback-and-history.md#known-good-firmware-and-probation): in an executable, a device's first known-good firmware is its packaged one, not the firmware it starts with. That decision stays as it is, with this note.
- The workaround that [Watching two Bun bugs before reporting them](261119_031624-watching-bun-bugs.md#the-workarounds-stay) keeps applies inside an executable too, since firmware is imported there as outside one.
- Documentation: a section of "Running a rack" on executables; `rack compile` and the executable's command line in the reference of the `rack` command; `packaged` in the reports; the limits; and the README's Status, without single executables in "Not supported yet".
- Not in this decision: installers, code signing, and net-tool's sidecar; `rack dev` and `rack plan` in an executable; and updating the executable itself.
- Follow-up: net-tool as a sidecar of its Tauri shell, with its installers, in a decision of its own.

## Implementation

- `rack compile` is `compileRack()` in `src/compile.ts`, which `src/cli.ts` runs.
  - It builds each device file with `buildFirmware()` and a `PackagedBuild`, into `.rack/compile/` under the manifest's directory, and removes that directory after.
  - It writes three entries there: a prelude, which installs the executable's `import.meta` paths before any packaged module loads; a main entry, which calls `runExecutable()` with the table of what it packaged; and the Worker host's entry, which puts rack42u and `rack42u/std` under `HOST_MODULES` for firmware, then loads `src/worker.ts`.
  - It compiles them, with the firmware and one module for each carried package, by the `compile` option of `Bun.build`, which takes plugins.
- `src/packaged.ts` holds `PackagedTable`, which an executable carries, the keys of device files, and `installImportMeta()`.
  - A file in the app's directory, outside `node_modules`, has its path from that directory as its key; in the executable, that path under the base directory is its outside file's place.
  - Any other file, such as one of rack42u's own devices, has `~/` and that path, with `_up_` for each `..`, under the executable's root, where no file is.
  - Packaged code calls a function by key for its `import.meta` paths. The plugin `rack42u-packaged-import-meta` rewrites the paths of the manifest, of rack42u's modules in the main entry, and of firmware, so that `httpPanel()` and the other standard devices name their files by their keys.
- `src/firmware.ts`: builds for an executable use the plugins `rack42u-host`, which resolves `rack42u` and `rack42u/std` to the Worker host's copy, `rack42u-carried-packages` at run time, and `rack42u-record-packages` at compile time, and bundle every other import.
- `src/rack.ts`:
  - `#build()` gives a device file's packaged firmware, unless its outside file is there and hasn't failed while the rack started; a file that the executable didn't package is built only for a swap that names it, and otherwise fails with `RACK_MANIFEST` at start and `RACK_SWAP_REJECTED` at `plug()`.
  - A failure of an outside file while the rack starts is an `OutsideFailure`; `#powerUpFallingBack()` powers off what started, and starts again with that file's packaged firmware. A layout, a wiring, or a plan that fails makes each outside file whose firmware declares another model, height, priority, needs, or ports than its packaged firmware fall back.
  - `#settleKnownGood()` makes the packaged firmware known-good, puts the devices of outside files on probation, those wired to one another as one group, and marks and records each fallback.
  - A scanned rack scans the device files that the executable packaged, in the order that `rack compile` found them, and follows the plan file it packaged, without writing one.
  - `status()` gains `packaged`. Describe requests carry the base directory, and the Worker host sets it before firmware loads.
- `src/executable.ts` is the executable's command line, and `src/commands.ts` holds what it shares with `src/cli.ts`. Its `ctl` takes `--base-dir` in place of `rack ctl`'s `--dir`, so that both its commands name the base directory one way.
- `test/executable.test.ts` covers the decision's tests, and failures to load, to boot, to be wired, and of `selfTest`, the wiring groups, a scanned rack, a device the executable didn't package, and a second rack for one base directory. `test/reference.test.ts` holds the reference of the `rack` command to `src/cli.ts`, `src/commands.ts`, and `src/executable.ts`.
- Documentation: "A rack in one executable" in [Running a rack](../../docs/guides/running.md#a-rack-in-one-executable); `rack compile` and the command line of an executable in the reference of the `rack` command; `packaged` in the reports; "Executables" in the limits; the known-good firmware of an executable in [Updates](../../docs/guides/updates.md#fallback); the README; the docs map; and a row of the skill.

## Confirmation

- The user accepted this decision on 2026-11-20, after the Agent's report pointed out three of its choices: the executable's own directory as the default base directory, outside files that replace packaged devices but add none, and no option to refuse outside files. The user's words: "Approve, and merge into main."
