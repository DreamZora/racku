# Decision: Installers for net-tool, whose shell runs the rack as a sidecar compiled by rack compile

Status: proposed

## Background

- [A rack in one executable](261120_011627-single-executables.md#impact) names this decision as its follow-up: "net-tool as a sidecar of its Tauri shell, with its installers, in a decision of its own."
- [examples/net-tool](261118_173845-net-tool-example.md#what-the-tool-does) runs the tool from source, and says "Installers come later, with their own decision." It set aside a sidecar until a rack could be compiled, which it now can.
- An installed app has neither Bun nor the repository. Its shell needs:
  - the rack, in a file that the installer puts in place;
  - a directory for the rack's files, since the shell's own directory is a system directory, the inside of an app bundle, or an install directory;
  - a place for the rack's log. A release build of the shell has no console on Windows, and an app started from a desktop's menu shows none on any system.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability: the installed app stops its rack in order when it exits or crashes, as from source, and a device that a file replaces falls back to the packaged one when the file fails;
  - maintainability: development runs the rack from source, as it does now, and a release build differs only in how the shell starts the rack;
  - observability: the rack's log goes to a file, and the sidecar's `ctl` reaches the installed app's rack;
  - extensibility: a file replaces a device of the installed app, as an executable allows.

## Evidence

Measured on 2026-11-20 with Bun 1.4.4 and Rust 1.99.0 on Linux x64, with probe scripts outside the repository.

- **net-tool's rack as an executable.** `rack compile` packaged a copy of the rack's side into an executable of 105.1 MiB, 49.6 MiB with `gzip -6`, and 37.8 MiB with `xz -6`. Run with `--base-dir`, `--stop-on-stdin-close`, `--log json`, and `NET_TOOL_TOKEN`, in its base directory:
  - It started in 82 ms. A WebSocket with the token and the origin of a built app, `tauri://localhost`, opened. Through it, a TCP connection to an echo server, and a UDP datagram between two of the rack's sockets, went and came back.
  - At `ctl reload`, a `devices/ui.ts` alone in the base directory failed to build, with `RACK_SWAP_REJECTED` and `Could not resolve: "../connectors.ts"`, and `ui` ran on. With `connectors.ts` beside its directory, `ui` was swapped hot, `status()` no longer marked it `packaged`, and the WebSocket and the TCP connection stayed open.
  - Closing its standard input stopped it in order in 20 ms, with the exit code 0.
- **A Tauri bundle with the sidecar.** On a copy of `examples/net-tool/app`, `tauri build --config` took 89 s, Cargo's downloads included. The file it was given added `externalBin: ["binaries/net-tool-rack"]`, turned bundling on, and asked for a `.deb`.
  - The build copied `binaries/net-tool-rack-x86_64-unknown-linux-gnu` to `target/release/net-tool-rack`, beside the shell.
  - The `.deb`, 53.4 MiB, installs both in `/usr/bin`, 116 MiB in all, and depends on `libwebkit2gtk-4.1-0` and `libgtk-3-0`.
- **Tauri's source**, read on 2026-11-20:
  - `tauri-build` copies each `externalBin` into the profile's target directory, `target/debug` or `target/release`, at every build, development included. It takes the target triple out of the name, and fails the build when the file is missing. A sidecar can't have the Cargo package's name.
  - The shell plugin looks for a sidecar in the directory of the running executable, with `.exe` on Windows, and ends one with `SIGKILL` or by its job object.
- **Tauri's documentation**, read on 2026-11-20:
  - `tauri build --config <file>` merges the file into the configuration.
  - `app_local_data_dir()` is the identifier's directory in the user's local data: `$XDG_DATA_HOME`, or `~/.local/share`, on Linux; `~/Library/Application Support` on macOS; and `%LOCALAPPDATA%` on Windows. On Windows and Linux, the webview keeps its own data there.
  - `app_log_dir()` is its `logs` directory on Linux and Windows, and `~/Library/Logs/<identifier>` on macOS.
  - An NSIS installer installs for the current user by default, in `%LOCALAPPDATA%`, without administrator rights.
  - On macOS, the signing identity `-` signs a bundle ad hoc. Apple Silicon requires a signature of apps from the Internet, and users still allow an app signed ad hoc in Privacy & Security.
- Not measured yet: the builds on macOS and Windows, and whether GitHub's macOS and Windows runners show the window. The first run of the workflow below measures them.

## Decision

### The sidecar

- `bun run sidecar` in `examples/net-tool/app` packages the rack with `rack compile` into `src-tauri/binaries/net-tool-rack-<target triple>`, with `.exe` on Windows, which is the name that `externalBin` asks for. It takes the triple from `rustc --print host-tuple`. The sidecar's name isn't `net-tool`, the Cargo package's.
- `src-tauri/tauri.bundle.conf.json` holds what only the installers need: `externalBin`, bundling turned on for the installers below, and the ad-hoc signature on macOS. `bun run bundle` runs `bun run sidecar`, then `tauri build --config` with that file, which builds the window's pages, the shell, and the installer.
- `bun run tauri dev` reads only `tauri.conf.json`. So development needs no sidecar, and runs the rack from source, as [The Tauri shell](261118_173845-net-tool-example.md#the-tauri-shell) describes.
- `src-tauri/binaries/` is build output, outside version control.

### The shell of a built app

- A release build of the shell starts the sidecar beside its own executable, and a debug build starts the rack from source, as now. Both start it with `--stop-on-stdin-close --log json`, `NET_TOOL_TOKEN`, and their standard input a pipe. Both stop it the same way: they close the pipe, wait at most 15 s, and then kill it.
- The sidecar's base directory is `rack/` in the app's local data directory:
  - `~/.local/share/dev.rack42u.net-tool/rack` on Linux, or that directory in `$XDG_DATA_HOME`;
  - `~/Library/Application Support/dev.rack42u.net-tool/rack` on macOS;
  - `%LOCALAPPDATA%\dev.rack42u.net-tool\rack` on Windows.

  The shell creates it, passes it as `--base-dir`, and starts the sidecar in it, so that the `.env` the sidecar reads is the app's own.
- On Windows, the sidecar starts without a console window of its own, with `CREATE_NO_WINDOW`, since the shell of a release build has no console.
- The shell writes the rack's log lines to `rack.log` in the app's log directory, after it renames the previous run's file to `rack.old.log`. Once a run's file reaches 10 MiB, the shell writes a last line that says so, and drops the rest of that run's log. A debug build prints the lines on its console, as now.
- When the rack fails to start, the window stays open and shows the failure, with the path of the log. A debug build exits, as now.

### Replacing a device of the installed app

- As [Devices from outside files](261120_011627-single-executables.md#devices-from-outside-files) decides, a `devices/ui.ts` or a `devices/net.ts` in the base directory replaces the packaged device. It does so when the app starts, and at `net-tool-rack ctl reload --base-dir <base directory>`.
- Both device files import `../connectors.ts`. So a replacement needs `connectors.ts` in the base directory too, and the packaged devices keep the copy they were built with.
- A replacement that fails leaves the packaged device running, `degraded`, as [Falling back](261120_011627-single-executables.md#falling-back) decides, and the log says why.

### Installers

| System | Runner | Installer |
|---|---|---|
| Linux x64 | `ubuntu-latest` | `.deb` |
| macOS arm64 | `macos-latest` | `.dmg`, which holds the `.app` |
| Windows x64 | `windows-latest` | NSIS setup, which installs for the current user |

- Each installer puts the sidecar beside the shell: in `/usr/bin` on Linux, in the bundle's `Contents/MacOS` on macOS, and in the install directory on Windows.
- No developer identity signs them. Gatekeeper and SmartScreen warn before the first start, and the example's README says how to start the app anyway. On macOS, the bundle is signed ad hoc.
- There is no updater: a new version installs over the old one.

### The installer workflow

- `.github/workflows/net-tool.yml` runs only when started by hand: `gh workflow run net-tool.yml --ref <branch>`. It has one job per system of the table, and each job ends after 30 minutes. Each job:
  - installs Bun 1.4.4 with `oven-sh/setup-bun`, at the version that `check.yml` pins, and Rust 1.99.0 with the runner's `rustup`. On Linux, it also installs the packages that [Prerequisites](261118_173845-net-tool-example.md#prerequisites) lists, and Xvfb;
  - runs `bun install --frozen-lockfile` in the repository and in the app, then `bun run bundle`;
  - runs the smoke test of [Tests](#tests);
  - uploads the installer as the artifact `net-tool-<system>`, kept for 7 days.
- A change to the shell, to its configuration, or to the window's build gets a run of this workflow on its branch before it merges, as a change to platform behavior gets a manual run of `check.yml`.

### Failure modes

| Failure | Outcome |
|---|---|
| The sidecar is missing, or can't run | The window shows that the rack couldn't start, with the error. |
| The base directory can't be created | The same. |
| A replacement fails to build, to load, to boot, to be wired, or its `selfTest`, or crashes on probation | The packaged device runs, `degraded`, and the log warns. |
| A replacement without `connectors.ts` | It fails to build, with the same outcome. |
| A second copy of the app starts | Its rack refuses to start for the same base directory, and its window shows the failure. The first copy runs on. |
| The app exits | The rack stops in order within 15 s, or the shell kills it. |
| The app crashes, or is killed | The system closes the pipe, and the rack stops in order. Its last log lines are lost, since the shell wrote the log. |
| A run's log reaches 10 MiB | The shell says so in the file, and drops the rest of that run's log. |

### Bounds

| What | Bound |
|---|---|
| The sidecar | About 105 MiB on Linux x64, most of it Bun |
| An installer | About 55 MiB: the `.deb` was 53.4 MiB |
| The rack's log | 10 MiB per run, for this run and the previous one |
| The wait for the rack to stop | 15 s, then a kill, as now |
| A job of the installer workflow | 30 minutes |
| A run's installers | Kept for 7 days |

### Observation

- `rack.log` and `rack.old.log` in the app's log directory.
- `net-tool-rack ctl <operation> --base-dir <base directory>` reaches the installed app's rack, with the sidecar from `/usr/bin`, from `net-tool.app/Contents/MacOS`, or from the install directory.
- As in any executable, `status()` marks packaged devices with `packaged: true`, and the log says `<device> runs <file>` for each replacement.
- Each run of the workflow shows its steps, and keeps its installers as artifacts.

### Tests

- In the repository's suite, which `check.yml` runs on Linux, macOS, and Windows: net-tool's rack compiled with `rack compile`, and run as the shell of a built app runs it:
  - A WebSocket with the token and the origins of a built app opens a TCP connection to a test server and gets its bytes back.
  - At `ctl reload`, a `devices/ui.ts` with `connectors.ts` in the base directory replaces the packaged `ui`, and the WebSocket stays open. Without `connectors.ts`, the reload fails with `RACK_SWAP_REJECTED`, and `ui` runs on.
  - Closing its standard input stops it in order.
- In the installer workflow, on each system:
  - `bun run bundle` writes the installer.
  - The smoke test, `app/scripts/smoke.ts`, installs it: with `apt` from the `.deb`, by copying the `.app` from the `.dmg`, or by running the NSIS setup silently.
  - It starts the installed app, under Xvfb on Linux. It waits until `rack.log` shows the panel listening, and until `ctl status` shows the window's WebSocket on the panel's listener.
  - It kills the app, and checks that the rack stopped in order: its control file goes away.
- Should a runner be unable to show a window, the smoke test of that system starts the installed sidecar alone, and the README says that the window was checked by hand there.
- By hand, as the README lists: on Ubuntu, install the `.deb`, start the tool from the menu, connect, send and receive, replace `devices/ui.ts` as above, and exit.

### Dependencies

- None for rack42u, and no new crate or package for the example: the shell uses Tauri's path API and Rust's standard library.
- The workflow uses `actions/upload-artifact`, GitHub's own, under the MIT license. It is pinned by commit, as `check.yml` pins its actions.

## Alternatives

- **The sidecar in development too**, with `externalBin` in `tauri.conf.json`: one way to start the rack, but each `tauri dev` would compile the sidecar first, and an edit of a device would take effect through an outside file instead of its source.
- **The shell plugin's sidecar API**: less Rust, but it ends the rack with `SIGKILL` or its job object, without a shutdown in order, as [examples/net-tool](261118_173845-net-tool-example.md#alternatives) found for the plugin.
- **The sidecar's own directory as the base directory**, an executable's default: replacements would go in `/usr/bin`, inside an app bundle, or in an install directory, which may not be writable. An AppImage's is read-only.
- **The app's local data directory itself**: the webview keeps its data there on Windows and Linux.
- **AppImage, `.rpm`, and MSI**: more installers to build and check, for no user who needs them now. An AppImage also carries its own WebKit, and MSI needs WiX. Each can join the table later.
- **Installers at every push to `main`**: a macOS build for each merge, at about ten times the Linux rate, for a shell that rarely changes.
- **Installers built only by hand**: each system builds its own, and the user has only Linux.
- **Signing with a developer identity, and notarization**: they need certificates, and secrets in CI, so they need a decision of their own.
- **Tauri's updater**: it needs signing keys and a place to publish. [A rack in one executable](261120_011627-single-executables.md#impact) leaves updates of an executable out too.
- **Tauri's log plugin**: a new dependency, for a file that a few lines of the shell write.

## Impact

- New files in `examples/net-tool/app/`: `scripts/sidecar.ts`, `scripts/smoke.ts`, and `src-tauri/tauri.bundle.conf.json`. Its `package.json` gains the scripts `sidecar` and `bundle`, and the repository's `.gitignore` gains `examples/net-tool/app/src-tauri/binaries/`.
- New: `.github/workflows/net-tool.yml`.
- `src-tauri/src/main.rs`: a release build starts the sidecar with its base directory, writes the log file, and keeps the window open when the rack fails to start.
- `test/net-tool.test.ts` gains the tests of the compiled rack.
- Documentation:
  - The example's README gains the installers, how to build them, where an installed app keeps its rack's files and log, how to replace a device, and how to reach the rack with `ctl`.
  - [Running a rack from another program](../../docs/guides/running.md#running-a-rack-from-another-program) points to the example for a shell that ships its rack as an executable.
  - `AGENTS.md`: the current state, the repository structure, and the rule for the workflow.
- [examples/net-tool](261118_173845-net-tool-example.md) stays as it is: its shell is the debug build's, and this decision is the one that its "Installers come later" waits for.
- Costs:
  - about 55 MiB per installer;
  - up to 30 minutes per system for a run of the workflow, which is at most $1.86 for the macOS job, at the rate that [Continuous integration with Windows checked](261118_015210-ci-with-windows.md) uses; the Linux and Windows jobs cost less;
  - about 160 MiB of artifact storage for 7 days per run.
- Security: whoever can write the app's local data directory, which is the user's own, can run code in the rack with the user's rights. [A rack in one executable](261120_011627-single-executables.md#impact) says the same of any base directory.
- Follow-ups, each in a decision of its own: signing and notarization, an updater, more installers, and more systems, such as Linux arm64.
