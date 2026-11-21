# Decision: Installers for net-tool, whose shell runs the rack as a sidecar compiled by rack compile

Status: proposed

## Background

- [A rack in one executable](261120_011627-single-executables.md#impact) names this decision as its follow-up: "net-tool as a sidecar of its Tauri shell, with its installers, in a decision of its own."
- [examples/net-tool](261118_173845-net-tool-example.md#what-the-tool-does) runs the tool from source, and says "Installers come later, with their own decision." It set aside a sidecar until a rack could be compiled, which it now can.
- An installed app has neither Bun nor the repository. Its shell needs:
  - the rack, in a file that the installer puts in place;
  - a directory for the rack's files, since the shell's own directory is a system directory, the inside of an app bundle, or an install directory;
  - a place for the rack's log. A release build of the shell has no console on Windows, and an app started from a desktop's menu shows none on any system.
- The user's direction on 2026-11-20, on replacing a device of the installed app: "Device replacement should have control logic; it needs to be configurable whether replacement is triggered manually or done by automatic scanning." [Executables that apply changed device files on command, or as they change with --watch](261120_221450-watching-outside-files.md) gives an executable both ways; this decision lets the app's user choose.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability: the installed app stops its rack in order when it exits or crashes, as from source, and a device that a file replaces falls back to the packaged one when the file fails;
  - maintainability: development runs the rack from source, as it does now, and a release build differs only in how the shell starts the rack;
  - observability: the rack's log goes to a file, and the window shows each device, what it runs, and why it failed;
  - extensibility: a file replaces a device of the installed app, by hand or as it changes, as the user chooses.

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
  - `app_config_dir()` is the identifier's directory in `$XDG_CONFIG_HOME`, or `~/.config`, on Linux; in `~/Library/Application Support` on macOS; and in `%APPDATA%` on Windows.
  - `app_log_dir()` is its `logs` directory on Linux and Windows, and `~/Library/Logs/<identifier>` on macOS.
  - An NSIS installer installs for the current user by default, in `%LOCALAPPDATA%`, without administrator rights.
  - On macOS, the signing identity `-` signs a bundle ad hoc. Apple Silicon requires a signature of apps from the Internet, and users still allow an app signed ad hoc in Privacy & Security.
- **GitHub's runners and workflows**, read on 2026-11-20:
  - On `windows-latest`, a job runs as `runneradmin` in the console session, with Explorer and a desktop of 1024×768, as a project that probed `windows-2025` reports. [Tauri's guide to tests in CI](https://v2.tauri.app/develop/tests/webdriver/ci/) runs a Tauri app on `windows-latest`, and on `ubuntu-latest` under Xvfb.
  - On hosted macOS runners, a GUI app that a job starts opens its window. Screen captures meet a consent prompt on macOS 15 and 26, so the smoke test below takes none. `macos-latest` is macOS 26 on arm64.
  - GitHub's documentation says of `workflow_dispatch`: "This event will only trigger a workflow run if the workflow file exists on the default branch", and "Once a workflow has run at least once, you can dispatch it against any branch or tag via the GitHub API or GitHub CLI." A `push` runs workflows that aren't on the default branch.
- Not measured yet: the builds on macOS and Windows, and the installed app on their runners. The first run of the workflow below measures them.

## Decision

### The sidecar

- `bun run sidecar` in `examples/net-tool/app` packages the rack with `rack compile` into `src-tauri/binaries/net-tool-rack-<target triple>`, with `.exe` on Windows, which is the name that `externalBin` asks for. It takes the triple from `rustc --print host-tuple`. The sidecar's name isn't `net-tool`, the Cargo package's.
- `src-tauri/tauri.bundle.conf.json` holds what only the installers need: `externalBin`, bundling turned on for the installers below, and the ad-hoc signature on macOS. `bun run bundle` runs `bun run sidecar`, then `tauri build --config` with that file, which builds the window's pages, the shell, and the installer.
- `bun run tauri dev` reads only `tauri.conf.json`. So development needs no sidecar, and runs the rack from source, as [The Tauri shell](261118_173845-net-tool-example.md#the-tauri-shell) describes.
- `src-tauri/binaries/` is build output, outside version control.

### The shell of a built app

- A release build of the shell starts the sidecar beside its own executable, and a debug build starts the rack from source, as now. Both start it with `--stop-on-stdin-close --log json`, `NET_TOOL_TOKEN`, and their standard input a pipe, and a release build adds `--watch` when the setting below is `automatic`. Both stop it the same way: they close the pipe, wait at most 15 s, and then kill it.
- The sidecar's base directory is `rack/` in the app's local data directory:
  - `~/.local/share/dev.rack42u.net-tool/rack` on Linux, or that directory in `$XDG_DATA_HOME`;
  - `~/Library/Application Support/dev.rack42u.net-tool/rack` on macOS;
  - `%LOCALAPPDATA%\dev.rack42u.net-tool\rack` on Windows.

  The shell creates it, passes it as `--base-dir`, and starts the sidecar in it, so that the `.env` the sidecar reads is the app's own.
- On Windows, the sidecar starts without a console window of its own, with `CREATE_NO_WINDOW`, since the shell of a release build has no console.
- The shell writes the rack's log lines to `rack.log` in the app's log directory, after it renames the previous run's file to `rack.old.log`. Once a run's file reaches 10 MiB, the shell writes a last line that says so, and drops the rest of that run's log. A debug build prints the lines on its console, as now.
- When the rack fails to start, the window stays open and shows the failure, with the path of the log. A debug build exits, as now.

### Replacing a device of the installed app

- As [Devices from outside files](261120_011627-single-executables.md#devices-from-outside-files) decides, a `devices/ui.ts` or a `devices/net.ts` in the base directory replaces the packaged device. Both device files import `../connectors.ts`, so a replacement needs `connectors.ts` in the base directory too, and the packaged devices keep the copy they were built with.
- The setting `replaceDevices` decides when a file applies:
  - `manual`, the default: when the app starts, and when the user clicks **Reload** in the window's Devices dialog, or runs `net-tool-rack ctl reload --base-dir <base directory>`.
  - `automatic`: also as soon as it is written, since the shell starts the sidecar with `--watch`, as [On command, or as files change](261120_221450-watching-outside-files.md#on-command-or-as-files-change) decides.
- The setting is in `settings.json` in the app's config directory, as `{ "replaceDevices": "manual" }` or `{ "replaceDevices": "automatic" }`:
  - `~/.config/dev.rack42u.net-tool/settings.json` on Linux, or that directory in `$XDG_CONFIG_HOME`;
  - `~/Library/Application Support/dev.rack42u.net-tool/settings.json` on macOS;
  - `%APPDATA%\dev.rack42u.net-tool\settings.json` on Windows.

  The shell reads it when the app starts, so a change applies at the next start; applying it at once would restart the rack, and close the sockets of `net`. Without the file, the setting is `manual`. The shell writes the file to a new file beside it, which it then renames over it, so that a crash leaves the old setting or the new one.
- A replacement that fails leaves the packaged device running, `degraded`, as [Falling back](261120_011627-single-executables.md#falling-back) decides, and the log and the Devices dialog say why.
- A debug build reads the setting, but runs the rack from source with `rack start` either way, since `rack dev` would watch `app/` too, with its `node_modules` and Cargo's `target/`. Its Devices dialog says so, and its **Reload** applies edits of the sources, as `rack ctl reload` does.

### The Devices dialog

- A **Devices** button in the window's toolbar opens a dialog that shows:
  - each device, with its state, `packaged` or the file it runs, and its error when it has one, from `ctl status`;
  - the directory that replacements go in, which the user can copy;
  - the setting, **Manual** or **Automatic**, and the one the running rack uses;
  - **Reload**, which runs `ctl reload`, then shows each device that it replaced, and each that failed, with its code and message.
- The shell gives the window three commands, `devices()`, `reload_devices()`, and `set_replace_devices(mode)`. They run the sidecar's `ctl` with the base directory. A debug build runs `bun src/cli.ts ctl` with `--dir examples/net-tool` instead.
- Each `ctl` gets 60 s. Then the shell kills it, and the command fails with a message that says so.

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

- `.github/workflows/net-tool.yml` has one job per system of the table, and each job ends after 30 minutes. Each job:
  - installs Bun 1.4.4 with `oven-sh/setup-bun`, at the version that `check.yml` pins, and Rust 1.99.0 with the runner's `rustup`. On Linux, it also installs the packages that [Prerequisites](261118_173845-net-tool-example.md#prerequisites) lists, and Xvfb;
  - runs `bun install --frozen-lockfile` in the repository and in the app, then `bun run bundle`;
  - runs the smoke test of [Tests](#tests);
  - uploads the installer as the artifact `net-tool-<system>`, kept for 7 days, and on a failure, the logs of the rack and the smoke test as `net-tool-<system>-logs`.
- Two things start it:
  - a push to any branch but `main` that changes `net-tool.yml`, since a change to a workflow is checked only by running it, and GitHub starts a workflow by hand only once it is on the default branch or has run once;
  - `gh workflow run net-tool.yml --ref <branch>`.

### When the workflow runs

The user left this to the Agent on 2026-11-20: "Decide for yourself when it is appropriate to run it." So:

- Before a branch merges into `main`, the Agent starts a run on it, without asking, when the branch changed anything in `examples/net-tool/app/` since the last run that passed, or moved the Bun minimum. The run must pass on a commit whose `examples/net-tool/app/` and `net-tool.yml` are the ones that merge.
- The Agent also starts one when a change elsewhere could break the installed app, such as a change to how an executable starts, stops, or finds its files, and says why in its report.
- After a failure, the Agent fixes the cause before the next run. It runs an unchanged commit again only once, for a failure that it shows came from the runner, such as a download that failed.
- Nothing else runs it: not each push, and not a merge, since `main` then takes a commit that a run passed.
- Manual runs of `check.yml` still wait for the user's word, as before.

### Failure modes

| Failure | Outcome |
|---|---|
| The sidecar is missing, or can't run | The window shows that the rack couldn't start, with the error. |
| The base directory can't be created | The same. |
| A replacement fails to build, to load, to boot, to be wired, or its `selfTest`, or crashes on probation | The packaged device runs, `degraded`, and the log and the Devices dialog say why. |
| A replacement without `connectors.ts` | It fails to build, with the same outcome. |
| `settings.json` can't be read or parsed, or holds another value | The shell uses `manual`, and the Devices dialog shows why. The file stays as it is until the user picks a setting. |
| The settings can't be written | The setting stays as it was, and the dialog shows the error. |
| The watch can't start | The rack runs on, and replacements apply at **Reload**, as [Failure modes](261120_221450-watching-outside-files.md#failure-modes) decides; the log says why. |
| A `ctl` of the dialog doesn't end within 60 s, or fails | The shell kills it, and the dialog shows the error. The rack runs on. |
| A second copy of the app starts | Its rack refuses to start for the same base directory, and its window shows the failure. The first copy runs on. |
| The app exits | The rack stops in order within 15 s, or the shell kills it. |
| The app crashes, or is killed | The system closes the pipe, and the rack stops in order. Its last log lines are lost, since the shell wrote the log. |
| A run's log reaches 10 MiB | The shell says so in the file, and drops the rest of that run's log. |
| A runner can't open the window | The smoke test fails at its wait for the window, with the step it reached, and the job uploads the logs. |

### Bounds

| What | Bound |
|---|---|
| The sidecar | About 105 MiB on Linux x64, most of it Bun |
| An installer | About 55 MiB: the `.deb` was 53.4 MiB |
| The rack's log | 10 MiB per run, for this run and the previous one |
| The wait for the rack to stop | 15 s, then a kill, as now |
| A `ctl` of the Devices dialog | 60 s, then a kill |
| The smoke test's waits | 60 s for the panel and for the window, 10 s for a watched change, and 20 s for the rack to stop |
| A job of the installer workflow | 30 minutes |
| A run's installers and logs | Kept for 7 days |

### Observation

- `rack.log` and `rack.old.log` in the app's log directory.
- The Devices dialog: each device's state, what it runs, and its error; the setting, and the one the rack uses; and the results of **Reload**.
- `net-tool-rack ctl <operation> --base-dir <base directory>` reaches the installed app's rack, with the sidecar from `/usr/bin`, from `net-tool.app/Contents/MacOS`, or from the install directory.
- As in any executable, `status()` marks packaged devices with `packaged: true`, and the log says `<device> runs <file>` for each replacement.
- Each run of the workflow shows its steps, and keeps its installers, and on a failure its logs, as artifacts.

### Tests

- In the repository's suite, which `check.yml` runs on Linux, macOS, and Windows: net-tool's rack compiled with `rack compile`, and run as the shell of a built app runs it:
  - A WebSocket with the token and the origins of a built app opens a TCP connection to a test server and gets its bytes back.
  - Without `--watch`, a `devices/ui.ts` with `connectors.ts` written in the base directory waits for `ctl reload`, which replaces the packaged `ui`, and the WebSocket stays open. Without `connectors.ts`, the reload fails with `RACK_SWAP_REJECTED`, and `ui` runs on.
  - With `--watch`, such a replacement applies without `ctl reload`, and the WebSocket stays open.
  - Closing its standard input stops it in order.
- In the installer workflow, on each system, `bun run bundle` writes the installer, and the smoke test, `app/scripts/smoke.ts`:
  - installs it: with `apt` from the `.deb`, by copying the `.app` from the `.dmg`, or by running the NSIS setup silently;
  - starts the installed app without `settings.json`, under Xvfb on Linux. It waits until `rack.log` shows the panel listening, and until `ctl status`, with the installed sidecar, shows the window's WebSocket on the panel's listener;
  - writes `devices/ui.ts` and `connectors.ts` from the repository in the base directory, checks after 2 s that `ui` still runs its packaged firmware, runs `ctl reload`, and checks that `ui` runs the file, with the window's WebSocket still open;
  - kills the app, and waits until `ctl status` says that no rack runs for the base directory, which it says once the rack has stopped in order and removed its control endpoint;
  - writes `settings.json` with `automatic`, starts the app again, and waits for the window. It checks that `ui` runs the file, edits the file, and waits until `ui` runs the new firmware, without `ctl reload`. It kills the app, and waits for the rack to stop, as before.
- By hand, as the README lists: on Ubuntu, install the `.deb`, start the tool from the menu, connect, send and receive; in the Devices dialog, switch the setting, restart the app, and replace `devices/ui.ts` both ways; check that a broken replacement shows its error; and exit.

### Dependencies

- None for rack42u, and no new crate or package for the example: the shell uses Tauri's path API, `serde_json`, and Rust's standard library, and the dialog uses Quasar.
- The workflow uses `actions/upload-artifact`, GitHub's own, under the MIT license. It is pinned by commit, as `check.yml` pins its actions.

## Alternatives

- **The sidecar in development too**, with `externalBin` in `tauri.conf.json`: one way to start the rack, but each `tauri dev` would compile the sidecar first, and an edit of a device would take effect through an outside file instead of its source.
- **The shell plugin's sidecar API**: less Rust, but it ends the rack with `SIGKILL` or its job object, without a shutdown in order, as [examples/net-tool](261118_173845-net-tool-example.md#alternatives) found for the plugin.
- **The sidecar's own directory as the base directory**, an executable's default: replacements would go in `/usr/bin`, inside an app bundle, or in an install directory, which may not be writable. An AppImage's is read-only.
- **The app's local data directory itself**: the webview keeps its data there on Windows and Linux.
- **A setting edited by hand, without the dialog**: less code, but the user of an installed app would edit JSON in a hidden directory, and type `ctl reload` with two long paths.
- **The shell speaking the control protocol itself**: no `ctl` process per command, but HTTP over a Unix socket, and the control file on Windows, in Rust, with a crate for it.
- **Applying a changed setting at once**: the rack would restart, and the TCP connections and servers of `net` would close at a click.
- **A smoke test without the window, for a runner that can't open one**: the reports above say that all three runners can, and a job that can't is a failure to examine, not one to pass.
- **AppImage, `.rpm`, and MSI**: more installers to build and check, for no user who needs them now. An AppImage also carries its own WebKit, and MSI needs WiX. Each can join the table later.
- **Installers at every push to `main`**: a macOS build for each merge, at about ten times the Linux rate, for a shell that rarely changes.
- **Installers built only by hand**: each system builds its own, and the user has only Linux.
- **Signing with a developer identity, and notarization**: they need certificates, and secrets in CI, so they need a decision of their own.
- **Tauri's updater**: it needs signing keys and a place to publish. [A rack in one executable](261120_011627-single-executables.md#impact) leaves updates of an executable out too.
- **Tauri's log plugin**: a new dependency, for a file that a few lines of the shell write.

## Impact

- New files in `examples/net-tool/app/`: `scripts/sidecar.ts`, `scripts/smoke.ts`, `src/Devices.vue`, and `src-tauri/tauri.bundle.conf.json`. Its `package.json` gains the scripts `sidecar` and `bundle`, and the repository's `.gitignore` gains `examples/net-tool/app/src-tauri/binaries/`.
- New: `.github/workflows/net-tool.yml`.
- `src-tauri/src/main.rs`: a release build starts the sidecar with its base directory, and with `--watch` when the setting says so; the shell writes the log file, keeps the window open when the rack fails to start, and gains the dialog's three commands.
- `src/App.vue`: the **Devices** button.
- `test/net-tool.test.ts` gains the tests of the compiled rack.
- Documentation:
  - The example's README gains the installers, how to build them, where an installed app keeps its rack's files, its setting, and its log, how to replace a device both ways, and how to reach the rack with `ctl`.
  - [Running a rack from another program](../../docs/guides/running.md#running-a-rack-from-another-program) points to the example for a shell that ships its rack as an executable.
  - `AGENTS.md`: the current state, the repository structure, and when the workflow runs.
- [examples/net-tool](261118_173845-net-tool-example.md) stays as it is: its shell is the debug build's, and this decision is the one that its "Installers come later" waits for.
- Costs:
  - about 55 MiB per installer;
  - up to 30 minutes per system for a run of the workflow, which is at most $1.86 for the macOS job, $0.30 for the Windows job, and $0.18 for the Linux job, at the rates that [Continuous integration with Windows checked](261118_015210-ci-with-windows.md) uses;
  - about 160 MiB of artifact storage for 7 days per run.
- Security: whoever can write the app's local data directory, which is the user's own, can run code in the rack with the user's rights. [A rack in one executable](261120_011627-single-executables.md#impact) says the same of any base directory. With `automatic`, such a file runs at once, not at the next start or **Reload**.
- Follow-ups, each in a decision of its own: signing and notarization, an updater, more installers, and more systems, such as Linux arm64.
