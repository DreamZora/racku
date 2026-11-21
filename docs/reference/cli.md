# The rack command

## Commands

| Command | Does |
|---|---|
| `rack start [manifest]` | Starts the rack in `manifest`, `rack.ts` in the current directory by default. |
| `rack dev [manifest]` | Starts the rack, then reloads the devices whose files change. |
| `rack plan [manifest]` | Prints the plan without starting the rack. For a scanned rack, `--write` writes the plan file, and `--check` checks it. |
| `rack compile [manifest]` | Packages the rack in `manifest` into one executable, as [A rack in one executable](../guides/running.md#a-rack-in-one-executable) describes, and prints each device it packaged with its firmware hash, and the executable's path and size. A device that fails to build fails it, with exit code 1, and no executable is written. |
| `rack ctl <operation>` | Operates the rack that runs from the current directory, as [Managing a running rack](../guides/managing.md) describes. |

## Exit codes

| Code | When |
|---|---|
| 0 | The rack shut down in order. |
| 1 | The rack failed to start, or a second stop came during the shutdown and ended it at once. |
| 2 | The command line is wrong, such as an unknown command or flag. |

## Flags of rack start and rack dev

| Flag | Meaning |
|---|---|
| `--no-plan` | Run a scanned rack without its plan file: the dependency graph and the priorities alone decide the order. See [The plan file](../guides/racks.md#the-plan-file). |
| `--no-watchdog` | Turn off every watchdog, as the `start()` option `watchdog: 0` does, such as while a debugger holds devices at breakpoints. |
| `--control-port <port>` | Open the management endpoint on loopback TCP at this port, with a token, in place of the Unix socket. See [Who can connect](../guides/managing.md#who-can-connect). |
| `--log text`, `--log json` | `text`, the default, prints one line per entry, with warnings and errors on stderr. `json` prints each entry as one line of JSON on stdout, warnings and errors included: `{ time, level, device?, message, data? }`. A `bigint` in `data` is written as a string ending in `n`, and details that JSON can't hold, such as circular ones, as their `String()`. |
| `--stop-on-stdin-close` | Read standard input, drop what arrives, and shut down in order when it closes, as on `SIGTERM`. Signals and `rack ctl stop` work as before: whichever comes first starts the shutdown, and a second one ends it at once. |

## Flags of rack plan

| Flag | Meaning |
|---|---|
| `--write` | Write the plan file of a scanned rack. |
| `--check` | Exit with code 1 while the plan file is missing or no longer fits the devices, such as in CI. |

The two exclude each other, and a rack placed by hand takes neither.

## Flags of rack compile

| Flag | Meaning |
|---|---|
| `--outfile <file>` | The executable's path. By default, the rack's name next to the manifest, with `.exe` for Windows. |
| `--target <target>` | One of Bun's targets, such as `bun-linux-arm64` or `bun-windows-x64`, for an executable of another system; Bun downloads that system's runtime once. By default, the executable is for the system that compiles it. |

## Operations of rack ctl

`rack ctl` runs one operation of the rack handle on the rack whose base directory is the current directory, prints its result as JSON, and exits with code 0, or prints the error and exits with code 1.

| Operation | Runs |
|---|---|
| `rack ctl status` | `status()` |
| `rack ctl metrics` | `metrics()` |
| `rack ctl reload` | `reload()` |
| `rack ctl swap <device> [source]` | `swap(device, source?)` |
| `rack ctl restart <device> [--no-cascade]` | `restart(device)`, or `restart(device, { cascade: false })` |
| `rack ctl rollback <device> [--to <firmware>]` | `rollback(device)`, or `rollback(device, { to })` |
| `rack ctl history [device]` | `history(device?)` |
| `rack ctl stop` | `stop()`, which shuts the rack down in order |

## Flags of rack ctl

| Flag | Meaning |
|---|---|
| `--dir <path>` | Operate the rack whose base directory is `path`, in place of the current directory. |
| `--url <url>`, `--token <token>` | Reach a rack's TCP endpoint at `url`, with its token, from anywhere on the machine. |
| `--no-cascade` | With `restart`: leave the device's consumers running. |
| `--to <firmware>` | With `rollback`: go back to this firmware, which the history keeps. |

## The command line of an executable

An executable that `rack compile` made starts the rack it packaged, as `rack start` starts a manifest, with the same flags, signals, and exit codes, and two flags of its own, `--base-dir` and `--watch`. With `ctl`, it operates the rack that it runs for the same base directory, with the operations of `rack ctl` and its flags, `--base-dir` in place of `--dir`. It reads a `.env` file in the directory where it starts, as `bun` does, but not a `bunfig.toml`.

```sh
./app --base-dir /var/lib/app --log json   # start the rack
./app --base-dir /var/lib/app --watch      # start it, and apply outside files as they change
./app ctl status --base-dir /var/lib/app   # operate it
```

| Flag | Meaning |
|---|---|
| `--base-dir <dir>` | The base directory, which stands for the manifest's directory: by default, the directory that holds the executable. |
| `--watch` | Also apply outside files as they change: watch the base directory, and reload the rack after a change to a device file or a JSON file, as `ctl reload` does. Without it, outside files apply when the rack starts, and at `ctl reload` and `ctl swap`. |

## Environment variables

| Variable | Meaning |
|---|---|
| `RACK_CONTROL_TOKEN` | The token of the TCP management endpoint, for `rack start` and `rack dev`, in place of a random one; `rack ctl` sends it, unless `--token` gives another. |
| `XDG_RUNTIME_DIR` | On Linux and macOS, the management endpoint's socket and control file live in `$XDG_RUNTIME_DIR/rack42u/`. |
| `XDG_STATE_HOME` | Without `XDG_RUNTIME_DIR`, they live in `$XDG_STATE_HOME/rack42u/control/`, and without either in `~/.local/state/rack42u/control/`. |
| `LOCALAPPDATA` | On Windows, the control file lives in `%LOCALAPPDATA%\rack42u\control\`. |
