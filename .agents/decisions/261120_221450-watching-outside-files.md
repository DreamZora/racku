# Decision: Executables that apply changed device files on command, or as they change with --watch

Status: accepted

## Background

- [A rack in one executable](261120_011627-single-executables.md#devices-from-outside-files) applies a device's outside file when the rack starts, and at each `reload()` and `swap(name)`, which `ctl reload` and `ctl swap` call. While the rack runs, "Nothing changes until `reload()` or `swap(name)`", as its failure modes say. It leaves `rack dev` in an executable out.
- `rack dev` watches the manifest's directory with `watchAndReload()` in `src/dev.ts`, and reloads the rack 100 ms after the last change. A change to any file counts, apart from those in `node_modules` and the files and directories whose names start with a dot.
- The user's direction on 2026-11-20, on replacing a device of net-tool's installed app: "Device replacement should have control logic; it needs to be configurable whether replacement is triggered manually or done by automatic scanning." [Installers for net-tool](261120_203926-net-tool-installers.md#replacing-a-device-of-the-installed-app) offers both to the app's user, with this decision's mechanism.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability: a change that the rack notices goes through the reload that `ctl reload` starts, with its probation and fallback; the data that a device keeps in the base directory starts no reloads; and every wait is bounded;
  - maintainability: `rack dev` and executables share one watcher;
  - observability: the log says when the rack watches, what each reload did, and when watching stops;
  - extensibility: the program that runs an executable chooses, at each start, whether files apply on command or as they change.

## Evidence

Measured on 2026-11-20 with Bun 1.4.4 on Linux x64, with probe scripts outside the repository:

- `fs.watch` with `recursive: true`, under `bun` and in an executable from `bun build --compile` alike, reported:
  - a file written at the top of the watched directory;
  - files written in directories made after the watch began: one at a time, with their parents at once, and moved in with their files;
  - an edit, a removal, and a file renamed over another, as editors save.
- When the watched directory itself was removed, the callback got `undefined` for the file name, then nothing more, also after the directory was made again. No `error` event came.
- `rack dev`'s callback compares the name with `null` only. So the `undefined` throws a `TypeError` out of it, which ended a long-running process at once, with the exit code 1: removing the base directory of `rack dev` ends it without a shutdown in order.

## Decision

### On command, or as files change

- An executable applies outside files on command, as now: when the rack starts, and at `ctl reload` and `ctl swap`.
- With `--watch`, it also watches its base directory, and reloads the rack after a change, as `ctl reload` does: it builds each outside file again, replaces each device whose firmware changed, and returns a device whose outside file is gone to its packaged firmware.
- `ctl reload` and `ctl swap` work with `--watch` too, and the rack runs one operation at a time, as now.
- `--watch` is the executable's second flag of its own, after `--base-dir`. The program that runs the executable sets it, such as a service manager or a Tauri shell, so that one executable serves both ways.

### What counts as a change

- A file whose name ends in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, or `.json` is written, renamed, or removed: the kinds that device files are written in, and JSON, which they often import.
- No file in `node_modules`, and no file or directory whose name starts with a dot, such as `.rack/` and `.env`, as for `rack dev`. No other kind of file, such as a database that a device keeps in the base directory.
- A change to another kind of file that firmware imports, such as `.txt`, applies at the next `ctl reload`.

### When the reload starts

- 100 ms after the last change, as for `rack dev`, and at most 1 s after the first, so that changes that never pause don't hold it off. `rack dev` gets the same bound, since it shares the watcher.
- One reload runs at a time. Changes during a reload start one more after it.

### Failure modes

| Failure | Outcome |
|---|---|
| The watch can't start, such as at the system's limit of watches | The rack runs on, and the log errors `cannot watch <dir>: <reason>`. Files apply at `ctl reload`. |
| The base directory is removed | Watching stops, the log errors `stopped watching <dir>: it was removed`, and the rack runs on. `rack dev` does the same, instead of ending. |
| A reload reads a file that is still being written | The file fails to build, and its device keeps what it runs, `degraded`, as at a failed `ctl reload`. The change that ends the write starts another reload. |
| A reload fails | The log errors `reload failed: <message>`, and watching goes on, as for `rack dev`. |
| Changes don't pause | A reload starts 1 s after the first of them. |
| A device writes code or JSON files in the base directory | Each write starts a reload, which replaces nothing unless firmware changed. Such files belong in a directory whose name starts with a dot, or outside the base directory. |

### Bounds

| What | Bound |
|---|---|
| Watches | One recursive watch of the base directory |
| Reloads | One at a time, and one more waiting |
| The wait before a reload | 100 ms after the last change, and at most 1 s after the first |
| Builds per reload | One per outside file, as at `ctl reload` |

### Observation

- The log says `watching <dir> for changes` when watching starts, as for `rack dev`, and errors `stopped watching <dir>: <reason>` when it stops.
- A watched reload logs what `ctl reload` logs, and `reload: no firmware changed` when it replaced nothing. `history()` records its swaps as those of `ctl reload`.

### Tests

- In `test/executable.test.ts`, which runs on Linux, macOS, and Windows, with the fixture app's executable:
  - With `--watch`, a device file written under the base directory runs without `ctl reload`; an edit of it replaces the device again; and removing it returns the device to its packaged firmware.
  - With `--watch`, files that don't count, such as `data.db`, `.draft.ts`, and one in `node_modules`, start no reload, while a file that counts, written after them, starts one.
  - Without `--watch`, a written file waits for `ctl reload`.
- `watchAndReload()` with a stub rack: changes every 50 ms start a reload within about 1 s, and a reload during a reload starts one more after it.
- `rack dev`: removing its base directory stops watching, with the log's error, and `--stop-on-stdin-close` still stops the rack in order, with the exit code 0.

### Dependencies

None.

## Alternatives

- **Scanning on a timer**: listing the base directory every few seconds needs no watch that can fail, but it works at every tick, and delays each change by up to its period, for what the system reports at once.
- **Only the files that firmware was built from, by the builds' inputs**: exact, but a file that a failed build couldn't find is in no build's inputs, so adding it would apply nothing until another change.
- **Every file, as for `rack dev`**: a database that a device writes in the base directory would start a reload at each write.
- **`dev` as a command of executables**: `rack dev` also keeps a scanned rack's plan file in step, which an executable never writes, and its name says development.
- **A setting in the manifest**: the choice would be made at compile time, and one executable couldn't serve both ways.
- **Switching at run time, with an operation of `ctl`**: a new operation of the management endpoint, for a choice that the program makes when it starts the executable.
- **Watching in the program that runs the executable**: each such program would need its own watcher, and net-tool's shell a crate for it.
- **`--watch` for `rack start`**: `rack dev` is that.

## Impact

- `src/dev.ts`: `watchAndReload()` takes which changes count, needs no manifest, waits at most 1 s, and handles a removed base directory.
- `src/commands.ts` and `src/executable.ts`: `--watch` for an executable.
- [A rack in one executable](261120_011627-single-executables.md#failure-modes) stays as it is, with this note: an outside file that changes while the rack runs changes nothing until `reload()` or `swap(name)`, unless the executable runs with `--watch`.
- Documentation: `--watch` in [The command line of an executable](../../docs/reference/cli.md#the-command-line-of-an-executable) and in [A rack in one executable](../../docs/guides/running.md#a-rack-in-one-executable); the wait before a reload, and what a removed base directory does, in [Hot reload with rack dev](../../docs/guides/running.md#hot-reload-with-rack-dev); and the watch's bounds in the limits.
- Costs: a flag, and the watch's work: one watch, and a reload per change that counts.
- Security: with `--watch`, a file that someone writes in the base directory runs at once, not at the next `ctl reload` or start. Whoever can write the base directory can run code in the rack either way, as [A rack in one executable](261120_011627-single-executables.md#impact) says.

## Confirmation

- The user accepted this decision on 2026-11-20, after the Agent's report on their three answers to [Installers for net-tool](261120_203926-net-tool-installers.md): `--watch` for every executable, the files that count as a change, the bound of 1 s on the wait before a reload, and the fix for a removed base directory of `rack dev`. The user's words: "Accept, Go ahead".
