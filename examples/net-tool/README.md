# net-tool

A desktop tool for TCP and UDP, built on racku. It opens TCP clients, TCP servers that accept connections, and UDP sockets, on the addresses and ports you enter. It sends what you type, as UTF-8 text or as hex, and shows what each socket sends and receives, as text or hex, with its time and direction.

The window is Vue 3 with Quasar, in a Tauri 2 shell. The sockets live in a rack beside it:

```text
examples/net-tool/
  rack.ts             the manifest: net, ui, and the HTTP panel
  connectors.ts       net/v1
  devices/net.ts      the sockets
  devices/ui.ts       the window's WebSocket protocol
  app/                the window
    src/              the Quasar frontend; codec.ts converts text and hex, Devices.vue is the
                      Devices dialog
    src-tauri/        the Tauri shell; tauri.bundle.conf.json is what only the installers need
    scripts/          sidecar.ts compiles the rack for the installers, smoke.ts tests one
```

| Slot | Device | What it does |
|---|---|---|
| 3 | `http-panel` | Listens on `127.0.0.1`, on a port the system picks, and routes `/ws` to `ui`. |
| 2 | `ui` | Holds the windows' WebSockets, runs their commands on `net`, and passes `net`'s events to every window. |
| 1 | `net` | Holds the sockets, with `Bun.connect`, `Bun.listen`, and `Bun.udpSocket`. |

## Running it

It runs from source. On Ubuntu, install Tauri's system libraries and Rust first, and make sure `cargo` is on your `PATH`:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

Then, from the repository root:

```sh
bun install
cd examples/net-tool/app
bun install
bun run tauri dev
```

The first run compiles the shell, which takes a minute or more. The shell then:

1. draws a token of 32 random bytes, and starts the rack with `bun` from your `PATH`: `src/cli.ts start examples/net-tool/rack.ts --stop-on-stdin-close --log json`, with `NET_TOOL_TOKEN` set to the token, `NET_TOOL_DEV` set to `1`, so that the rack accepts the development server's origin, and its standard input a pipe;
2. prints the rack's log, one JSON object per line, to its console, and takes the panel's URL from the `listening` entry;
3. gives the URL and the token to the window, which opens its WebSocket to `/ws`.

When you close the window, the shell closes the rack's standard input, so the rack shuts down in order. After 15 s it kills it. If the shell crashes, the system closes the pipe, and the rack stops by itself.

The window's **Devices** button opens a dialog with each device: its state, what it runs, and its error. Its **Reload** runs `ctl reload`, which applies your edits of `devices/`, as [What it shows of racku](#what-it-shows-of-racku) describes. A build from source always runs the rack with `rack start`, so the dialog's setting applies only to an installed app.

## How the window talks to the rack

- The window offers the subprotocols `net-tool` and `token.<token>`, since a browser's `WebSocket` can't send headers. `ui` accepts the upgrade only when the `Origin` is one of its `origins` and the token matches, compared in constant time; any other upgrade gets 403.
  - The origins are the built app's, `tauri://localhost` and `http://tauri.localhost`. The development server's, `http://localhost:5173`, counts only when `NET_TOOL_DEV` is `1`, as the shell of a debug build sets it, and never in an installed app's rack, whose shell removes the variable.
  - So a web page can't drive the tool, nor can a program of another user. A program that runs as your user can: it can read the token from the rack's environment.
- Its commands are JSON text, `{ id, op, input }`, where `op` is a `net/v1` RPC, `open`, `send`, `close`, or `list`, and `input` is that RPC's input, with bytes as base64.
- `ui` answers each command with `{ id, ok: true, value }` or `{ id, ok: false, error: { code, message } }`, and passes `net/v1`'s events, `{ event, ... }`, to every window: `opened`, `data`, and `closed`. An answer has `ok`, and an event has `event`.
- The window reconnects when its WebSocket closes, after 0.5 s, doubling up to 5 s, while the shell says that the rack runs. Once a rack that started has stopped, the shell says so, and the window shows it and stops reconnecting, so that it never sends the token to whatever listens on that port by then.
- `list` adds `delivered` to each socket: the `data` events that `ui` passed on. The window shows the difference from the socket's `events` as events missed on the way.

## What it shows of racku

Edit `devices/ui.ts` while the tool runs, and apply the edit from the repository root:

```sh
bun src/cli.ts ctl reload --dir examples/net-tool
```

`ui` is hot swapped: it hands its windows to the new instance with `snapshot` and `restore`, so the window stays connected, and the TCP connections stay open in `net`. Editing `devices/net.ts` instead replaces `net`, and its sockets close with the old instance, since a rack hands over only HTTP listeners; the window shows them closed.

## Installers

| System | Installer |
|---|---|
| Linux x64 | `.deb`, which installs the app in `/usr/bin` |
| macOS arm64 | `.dmg`, which holds `net-tool.app` |
| Windows x64 | an NSIS setup, which installs for your user, without administrator rights |

An installed app needs neither Bun nor this repository: its rack is the sidecar `net-tool-rack`, one executable that `rack compile` made, beside the shell. The shell starts it with `--base-dir`, `--stop-on-stdin-close`, and `--log json`, and stops it as from source.

- **Building one.** On the system it is for, with Rust and, on Linux, the packages of [Running it](#running-it), run `bun run bundle` in `app/`. It runs `bun run sidecar`, which compiles the rack into `src-tauri/binaries/net-tool-rack-<target triple>`, and then `tauri build --config src-tauri/tauri.bundle.conf.json`. The installer lands in `src-tauri/target/release/bundle/`, about 55 MiB, with the sidecar of about 105 MiB inside, most of it Bun.
- **Starting it.** No developer identity signs the installers. On macOS, the app is signed ad hoc, and the first start meets Gatekeeper: allow it in System Settings, under Privacy & Security, with **Open Anyway**. On Windows, SmartScreen warns before the setup runs: **More info**, then **Run anyway**. On Linux, `sudo apt install ./net-tool_0.1.0_amd64.deb`, then start net-tool from the menu.
- **Updating.** There is no updater: a new version installs over the old one.

### Where an installed app keeps its files

| | Linux | macOS | Windows |
|---|---|---|---|
| The rack's base directory | `~/.local/share/dev.racku.net-tool/rack` | `~/Library/Application Support/dev.racku.net-tool/rack` | `%LOCALAPPDATA%\dev.racku.net-tool\rack` |
| `settings.json` | `~/.config/dev.racku.net-tool/` | `~/Library/Application Support/dev.racku.net-tool/` | `%APPDATA%\dev.racku.net-tool\` |
| `rack.log` and `rack.old.log` | `~/.local/share/dev.racku.net-tool/logs/` | `~/Library/Logs/dev.racku.net-tool/` | `%LOCALAPPDATA%\dev.racku.net-tool\logs\` |

On Linux, `$XDG_DATA_HOME` and `$XDG_CONFIG_HOME` take the place of `~/.local/share` and `~/.config` when they are set.

- **The base directory** is the rack's: the sidecar starts there, and the rack writes the firmware of replacements in its `.rack/`. The sidecar reads no `.env` there: the shell gives it its environment.
- **The log.** The shell writes the rack's log lines there, one JSON object each, with the rack's own messages, after it renames the previous run's `rack.log` to `rack.old.log`. A run's log stops at 10 MiB, with a last line that says so. When the app is killed, the rack's last lines, of its shutdown, are lost.
- **A rack that can't start** leaves the window open, with the reason and the path of the log. So does the rack of a second copy of the app, which finds the first copy's rack running for the same base directory, and stops; the first copy runs on.

### Replacing a device of the installed app

A `devices/ui.ts` or a `devices/net.ts` in the base directory replaces the device packaged in the app. Both import `../connectors.ts`, so put a `connectors.ts` beside `devices/` too, such as copies of the files here. The setting **Replace devices**, in the Devices dialog, says when such a file applies:

- **Manual**, the default: when the app starts, and when you click **Reload** in the Devices dialog, or run `net-tool-rack ctl reload --base-dir <base directory>`.
- **Automatic**: also as soon as you write it, since the shell starts the rack with `--watch`. A change counts when the file's name ends in `.ts`, `.js`, `.json`, or another kind that device files are written in, as [A rack in one executable](../../docs/guides/running.md#a-rack-in-one-executable) lists.

The dialog writes the setting to `settings.json`, as `{ "replaceDevices": "manual" }` or `"automatic"`, and it applies at the next start, since applying it at once would restart the rack and close the sockets of `net`. The dialog shows the setting that the running rack uses. A `settings.json` that can't be read, or holds another value, gives **Manual**, and the dialog says why.

A replacement that fails, to build, to start, or on probation, leaves the packaged device running, `degraded`, and the dialog and the log say why. Removing the file returns the device to its packaged firmware at the next reload. Whoever can write the base directory can run code in the rack with your rights, and with **Automatic** at once.

### Reaching the installed app's rack

The sidecar's `ctl` operates the rack of the installed app, as `rack ctl` does:

```sh
/usr/bin/net-tool-rack ctl status --base-dir ~/.local/share/dev.racku.net-tool/rack
```

On macOS, the sidecar is `net-tool.app/Contents/MacOS/net-tool-rack`, and on Windows `net-tool-rack.exe` in the install directory.

## Limits

| What | Limit |
|---|---|
| Open sockets, accepted connections included | 64, `net`'s `maxSockets` |
| One TCP send | 64 KiB |
| One UDP datagram | 65 507 bytes |
| Bytes waiting to go out on one TCP socket | 1 MiB; a send beyond it fails with `RACK_OVERLOADED` |
| One command from the window | 1 MiB, the panel's `webSocket.maxMessageSize` |
| Messages the window keeps per socket | the last 10 000, and at most 8 MiB of them, of which it shows the last 500 |
| The wait for the rack to stop when the app exits | 15 s, then a kill |
| A `ctl` of the Devices dialog | 60 s, then a kill, and the dialog shows the error |
| The rack's log of an installed app | 10 MiB per run, for the run and the one before it |

## Checks

From the repository root, `bun test test/net-tool.test.ts` runs `net` and `ui` on the bench, the whole rack through its panel, and `codec.ts`; the repository's suite runs them on Linux, macOS, and Windows. In `app/`, `bun run check` checks the window's types, and `bun run build` builds it.

The suite also runs the rack compiled with `rack compile`, as the shell of an installed app runs it: a window's WebSocket with an installed app's origin, a replacement of `ui` with and without `--watch`, and its stop when its input closes.

The workflow `.github/workflows/net-tool.yml` builds the three installers on GitHub's runners, and its smoke test, `app/scripts/smoke.ts`, installs each one and starts the installed app: it waits for the window's WebSocket, replaces `ui` at `ctl reload` and then, with **Automatic**, as its file changes, and checks that the rack stops in order each time the app is killed. A run keeps the installers for 7 days, and on a failure the logs. Run the smoke test on a build of your own with `bun scripts/smoke.ts --app src-tauri/target/release/net-tool` in `app/`, under `xvfb-run -a` on a Linux without a display; it needs an app without a `settings.json` and without replacements.

The window itself and the Devices dialog aren't in CI. Check them by hand after changing them:

1. Start the tool with `bun run tauri dev`.
2. Open a TCP server on port 0, then a TCP client to its port, and send text and hex both ways.
3. Open a UDP socket on port 0, and send a datagram to its own port.
4. Edit `devices/ui.ts` while connected, click **Reload** in the Devices dialog, or run `ctl reload` as above, and check that the window stays connected and the sockets stay open.
5. Close the window, and check in the console that the rack stopped: `rack net-tool stopped`.
6. On Ubuntu, install the `.deb`, start the tool from the menu, connect, send, and receive. In the Devices dialog, switch **Replace devices**, restart the app, and replace `devices/ui.ts` both ways. Check that a broken replacement shows its error in the dialog, and exit.

In development, the window also runs in a browser at `http://localhost:5173/?url=<panel URL>&token=<token>`, for a rack started by hand with `NET_TOOL_TOKEN` set, and `NET_TOOL_DEV=1`.
