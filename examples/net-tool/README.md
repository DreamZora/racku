# net-tool

A desktop tool for TCP and UDP, built on rack42u. It opens TCP clients, TCP servers that accept connections, and UDP sockets, on the addresses and ports you enter. It sends what you type, as UTF-8 text or as hex, and shows what each socket sends and receives, as text or hex, with its time and direction.

The window is Vue 3 with Quasar, in a Tauri 2 shell. The sockets live in a rack beside it:

```text
examples/net-tool/
  rack.ts             the manifest: net, ui, and the HTTP panel
  connectors.ts       net/v1
  devices/net.ts      the sockets
  devices/ui.ts       the window's WebSocket protocol
  app/                the window
    src/              the Quasar frontend; codec.ts converts text and hex
    src-tauri/        the Tauri shell
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

1. draws a token of 32 random bytes, and starts the rack with `bun` from your `PATH`: `src/cli.ts start examples/net-tool/rack.ts --stop-on-stdin-close --log json`, with `NET_TOOL_TOKEN` set to the token and its standard input a pipe;
2. prints the rack's log, one JSON object per line, to its console, and takes the panel's URL from the `listening` entry;
3. gives the URL and the token to the window, which opens its WebSocket to `/ws`.

When you close the window, the shell closes the rack's standard input, so the rack shuts down in order. After 15 s it kills it. If the shell crashes, the system closes the pipe, and the rack stops by itself.

## How the window talks to the rack

- The window offers the subprotocols `net-tool` and `token.<token>`, since a browser's `WebSocket` can't send headers. `ui` accepts the upgrade only when the `Origin` is one of its `origins` and the token matches, compared in constant time; any other upgrade gets 403. So neither a web page nor another program on the machine can drive the tool.
- Its commands are JSON text, `{ id, op, input }`, where `op` is a `net/v1` RPC, `open`, `send`, `close`, or `list`, and `input` is that RPC's input, with bytes as base64.
- `ui` answers each command with `{ id, ok: true, value }` or `{ id, ok: false, error: { code, message } }`, and passes `net/v1`'s events, `{ event, ... }`, to every window: `opened`, `data`, and `closed`. An answer has `ok`, and an event has `event`.
- The window reconnects when its WebSocket closes, after 0.5 s, doubling up to 5 s.
- `list` adds `delivered` to each socket: the `data` events that `ui` passed on. The window shows the difference from the socket's `events` as events missed on the way.

## What it shows of rack42u

Edit `devices/ui.ts` while the tool runs, and apply the edit from the repository root:

```sh
bun src/cli.ts ctl reload --dir examples/net-tool
```

`ui` is hot swapped: it hands its windows to the new instance with `snapshot` and `restore`, so the window stays connected, and the TCP connections stay open in `net`. Editing `devices/net.ts` instead replaces `net`, and its sockets close with the old instance, since a rack hands over only HTTP listeners; the window shows them closed.

## Limits

| What | Limit |
|---|---|
| Open sockets, accepted connections included | 64, `net`'s `maxSockets` |
| One TCP send | 64 KiB |
| One UDP datagram | 65 507 bytes |
| Bytes waiting to go out on one TCP socket | 1 MiB; a send beyond it fails with `RACK_OVERLOADED` |
| One command from the window | 1 MiB, the panel's `webSocket.maxMessageSize` |
| Messages the window keeps per socket | the last 10 000, of which it shows the last 500 |
| The wait for the rack to stop when the app exits | 15 s, then a kill |

## Checks

From the repository root, `bun test test/net-tool.test.ts` runs `net` and `ui` on the bench, the whole rack through its panel, and `codec.ts`; the repository's suite runs them on Linux, macOS, and Windows. In `app/`, `bun run check` checks the window's types, and `bun run build` builds it.

The shell and the window aren't in CI. Check them by hand after changing them:

1. Start the tool with `bun run tauri dev`.
2. Open a TCP server on port 0, then a TCP client to its port, and send text and hex both ways.
3. Open a UDP socket on port 0, and send a datagram to its own port.
4. Edit `devices/ui.ts` while connected, run `ctl reload` as above, and check that the window stays connected and the sockets stay open.
5. Close the window, and check in the console that the rack stopped: `rack net-tool stopped`.

In development, the window also runs in a browser at `http://localhost:5173/?url=<panel URL>&token=<token>`, for a rack started by hand with `NET_TOOL_TOKEN` set.
