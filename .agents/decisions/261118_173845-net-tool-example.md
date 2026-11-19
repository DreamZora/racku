# Decision: examples/net-tool, a TCP and UDP tool on Tauri 2 and Quasar

Status: accepted

## Background

- On 2026-11-18 the user chose the first project on rack42u: "a graphical TCP/UDP client/server example tool using Bun + Tauri 2 (with Quasar for the frontend). It should be able to send and receive data as text or hex."
  - Its place: "`examples/net-tool` is fine."
  - Its order: "Plan this after the HTTP panel is designed." [The standard HTTP panel device](261118_071513-http-panel-device.md) is implemented and released in 0.4.0.
  - Installers were left to the Agent, who proposed to run the tool from source in P3 and to build installers later.
  - The user installs Rust and Tauri's system libraries, which need `sudo`.
- What the tool takes from rack42u:
  - the HTTP panel with WebSocket, through which its window talks to the rack;
  - devices that hold TCP and UDP sockets in their Workers;
  - [Running a rack under another program](261118_173838-running-under-another-program.md), since its Tauri shell starts the rack;
  - [A test bench for one device](261118_173457-device-test-bench.md), with which its devices are tested.
- What it shows of rack42u: editing the device that talks to the window, while the tool runs, keeps the window's WebSocket and the TCP connections open.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since every socket, message, and queue has a limit, and the rack stops in order when the app ends or crashes;
  - maintainability, since the sockets, the window's protocol, and the shell are separate parts, each tested on its own;
  - observability, since the window shows each socket's traffic, and the rack's log reaches the shell;
  - extensibility, since the tool is an example of an app built on devices, which [Project scope](261112_035941-project-scope.md) leaves to builders.

### Evidence

- **Sockets in a Worker**, from the [evidence of the panels decision](261118_070617-panels-as-devices.md#evidence): `Bun.serve`, `Bun.listen`, `Bun.connect`, and `Bun.udpSocket` all worked inside a Worker, on Linux.
- **Tauri 2**, from its documentation on 2026-11-18:
  - The prerequisites on Debian and Ubuntu are `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, and `librsvg2-dev`, and Rust through rustup.
  - In development, the window loads the page from `devUrl`, the frontend's development server. A built app serves its pages from `tauri://localhost` on macOS and Linux, and from `http://tauri.localhost` on Windows.
  - The shell plugin ends the children it started with `kill()` when the app exits.
  - `RunEvent::ExitRequested` and `RunEvent::Exit` let an app clean up before it exits.
- **The local machine**, Ubuntu 26.04.1 LTS: Bun 1.4.4 and Node 24.15.0 are installed, and GTK 3 and the app indicator library are there. Rust, and the development packages of WebKitGTK 4.1, libsoup 3, and librsvg, are missing.

## Decision

### What the tool does

- It opens TCP clients, TCP servers that accept connections, and UDP sockets, on the addresses and ports the user enters, and lists the open ones with their local and remote addresses.
- It sends what the user types, as text in UTF-8 or as hex, and shows what each socket sends and receives, as text or hex, with its time and direction.
- It runs from source in P3: `bun run tauri dev` in `examples/net-tool/app`. Installers come later, with their own decision.

### Layout

```text
examples/net-tool/
  README.md           what the tool does, the prerequisites, and how to run it
  rack.ts             the manifest: net, ui, and the HTTP panel
  connectors.ts       net/v1
  devices/net.ts      the sockets
  devices/ui.ts       the window's WebSocket protocol
  app/                the window
    package.json      Vue, Quasar, Vite, and Tauri's CLI and API; bun.lock beside it
    index.html
    vite.config.ts
    src/              the Quasar frontend; codec.ts converts text and hex
    src-tauri/        the Tauri shell: Cargo.toml, tauri.conf.json, src/main.rs
```

- The rack's side sits outside `app/`, so it imports `rack42u` by the package's own name, as `examples/shop-api` does, and the repository's type check, lint, and tests cover it.
- `app/` has its own `package.json`, so the window's dependencies stay out of rack42u's. The root's type check and lint skip `app/`, which checks itself with `vue-tsc` and its build. `.gitignore` adds `app/dist/` and `app/src-tauri/target/`.

### The rack

```ts
const ORIGINS = ["http://localhost:5173", "tauri://localhost", "http://tauri.localhost"];

export default rack("net-tool", {
  slots: {
    1: slot("./devices/net.ts", { config: { maxSockets: 64 } }),
    2: slot("./devices/ui.ts", { config: { token: process.env.NET_TOOL_TOKEN, origins: ORIGINS } }),
    3: httpPanel({ port: 0, routes: { "/ws": "ui.http" } }),
  },
});
```

- `net` holds the sockets, with `Bun.connect`, `Bun.listen`, and `Bun.udpSocket`, and provides `net/v1`.
- `ui` needs `net/v1` and provides `http/v2` through `httpHandler` with WebSocket handlers. Its configuration requires a token of at least 32 hex digits, so a rack started without `NET_TOOL_TOKEN` fails with `RACK_INVALID_CONFIG`.
- The panel listens on `127.0.0.1`, on a port the system picks.

### net/v1

| Member | Kind | Carries |
|---|---|---|
| `open` | RPC | `{ kind: "tcp-client" \| "tcp-server" \| "udp", host, port }` to `{ id, local, remote? }` |
| `send` | RPC | `{ id, data, to? }` to `{ sent }`: bytes, and for UDP the address to send to |
| `close` | RPC | `{ id }` |
| `list` | RPC | to the open sockets, each with its kind, addresses, and counters |
| `opened` | event | `{ id, server?, local, remote }`: a client that connected, or a connection a server accepted |
| `data` | event | `{ id, data, from? }`: bytes received, and for UDP the sender |
| `closed` | event | `{ id, error? }` |

- A socket's id is a counter of the instance, and a server's connections get ids of their own, with the server's id in `server`.
- Each read of a TCP socket, and each UDP datagram, is one `data` event.

### The window's protocol

- The window opens one WebSocket to `ws://127.0.0.1:<port>/ws`. It offers the subprotocols `net-tool` and `token.<token>`, since a browser's `WebSocket` can't send headers.
- `ui` accepts the upgrade only when the `Origin` header is one of its `origins` and the token matches, compared in constant time, and answers with the subprotocol `net-tool`. Otherwise it answers 403, as the panel decision leaves the check of origins and tokens to the device.
  - Its origins are the development server's, `http://localhost:5173` in P3, and the built app's, `tauri://localhost` and `http://tauri.localhost`.
- The messages are JSON text:
  - from the window, commands that mirror `net/v1`'s RPCs, `{ id, op, ... }`, with bytes as base64;
  - from `ui`, the answer to each command, `{ id, ok, value }` or `{ id, ok: false, error: { code, message } }`, and `net/v1`'s events, `{ event, ... }`, which go to every window that is connected.
- `ui` keeps its sockets across a hot swap with `handler.list()` and `handler.restore()`. So editing `devices/ui.ts` while the tool runs keeps the window connected and the TCP connections open.
- Editing `devices/net.ts` replaces `net`, and its sockets close with its old instance, since a rack hands over only HTTP listeners. The window shows them closed.

### The Tauri shell

- At start, the shell draws a token of 32 random bytes and starts the rack:

  ```text
  bun <repository>/src/cli.ts start <repository>/examples/net-tool/rack.ts --stop-on-stdin-close --log json
  ```

  - with `NET_TOOL_TOKEN` set to the token, and its standard input a pipe;
  - with Rust's `std::process`, not the shell plugin, which would end it without a shutdown in order;
  - with `bun` from `PATH`, and the repository's path from the shell's own source directory, since P3 runs the tool from source.
- It reads the rack's JSON lines, takes the URL from the panel's `listening` entry, and passes the URL and the token to the window through a Tauri command, `endpoint()`. It prints the other lines to its console.
- When the app exits, through `RunEvent::ExitRequested`, it closes the rack's standard input, waits for the rack to exit for at most 15 s, and then kills it. When the app crashes, the system closes the pipe, and the rack stops by itself.
- Its content security policy lets the window connect to `ws://127.0.0.1:*`.

### The window

- Vue 3 with Quasar, built by Vite, with Bun as the package manager.
- `app/src/codec.ts` converts what the user types and what arrives:
  - text to bytes as UTF-8, and bytes to text with U+FFFD for bytes that aren't UTF-8;
  - hex to bytes from pairs of hex digits, with optional spaces between them, and bytes to hex as pairs separated by spaces. Other characters, or an odd number of digits, are an error at the input, which isn't sent.
- The window keeps the last 10 000 messages per socket, and reconnects when its WebSocket closes, with a backoff from 0.5 s to 5 s.

### Failure modes

| Failure | Outcome |
|---|---|
| A web page opens a WebSocket to the tool's port | 403: its `Origin` isn't allowed, and it has no token |
| Another program on the machine connects | 403 without the token |
| The rack fails to start | the shell shows the rack's error lines and exits with an error |
| The app exits, or crashes | the rack's input closes, and it shuts down in order |
| A socket fails to connect, or an address is taken | the command answers with the error, which the window shows |
| The peer closes a connection | a `closed` event, which the window shows |
| More than `maxSockets` sockets | `open` fails with `RACK_OVERLOADED` |
| A send over the limits below | the command fails with `RACK_INVALID_INPUT` |
| The window reads too slowly | events beyond `queueLimit` are dropped and counted, and the panel closes a WebSocket with more than 1 MiB unsent, with 1013, after which the window reconnects |
| `net` crashes | the rack resets it, its sockets are gone, and `list` shows none; the window lists the sockets again when a command fails |

### Bounds

| What | Bound |
|---|---|
| Open sockets, accepted connections included | `maxSockets`, 64 by default |
| One TCP send | 64 KiB |
| One UDP datagram | 65 507 bytes |
| One command from the window | the panel's `webSocket.maxMessageSize`, 1 MiB |
| Events waiting for `ui` | `queueLimit`, as for every subscriber |
| Messages kept per socket in the window | the last 10 000 |
| The wait for the rack to stop when the app exits | 15 s, then a kill |

### Observation

- The window shows each socket's bytes sent and received, and the events dropped on the way to it, from `list` and from `ui`'s counters.
- The shell prints the rack's log to its console in development.

### Tests

- In the repository's suite, which runs on Linux, macOS, and Windows:
  - `net` on the bench: a TCP client to a server the test opens, a TCP server that accepts the test's connection, UDP both ways, `maxSockets`, the send limits, and closing.
  - `ui` on the bench, with a stub for `net/v1`: the token and the origins at the upgrade, commands and their answers, events to every window, and a hot swap that keeps the window's WebSocket.
  - The whole rack through its panel: a WebSocket client with the token opens a TCP connection to a test server and gets its bytes back.
  - `codec.ts`: text and hex in both directions, and the errors of hex input.
- Not in CI: the Tauri shell and the window, which need Rust and WebKitGTK. The example's README lists the checks to run by hand: start the tool, connect, send and receive as text and as hex, edit `devices/ui.ts` while connected, and exit.

### Prerequisites

The user installs, on Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

### Dependencies

- They are the example's, not rack42u's: Vue, Quasar and `@quasar/vite-plugin`, Vite and `@vitejs/plugin-vue`, `vue-tsc`, and `@tauri-apps/api` and `@tauri-apps/cli` in `app/package.json`; `tauri`, `tauri-build`, `serde`, `serde_json`, and `getrandom` in `app/src-tauri/Cargo.toml`.
- All are under the MIT license, or MIT or Apache-2.0, which [License](261112_035940-mit-license.md) allows.
- `app/bun.lock` is resolved from `https://registry.npmjs.org/`.

## Alternatives

- **The rack as a Tauri sidecar, compiled with `bun build --compile`**: the way to an installer, but P3 runs the tool from source, and compiling a rack whose devices are built at run time needs its own decision.
- **The shell plugin to start the rack**: less Rust, but it ends the rack with `kill()` when the app exits.
- **The window talks to the shell through Tauri's IPC, and the shell to the rack**: no token or origin to check, but every message would cross Rust, which would need a client of the rack's WebSocket.
- **Sockets in Rust, through Tauri commands**: the tool wouldn't use rack42u.
- **Binary WebSocket frames for data**: base64 costs a third more bytes, but one JSON format keeps the protocol simple, and 1 MiB per message bounds it.
- **A repository of its own**: how real users would work, but installing rack42u from a private repository at a tag is untested, and the user chose `examples/net-tool`.

## Impact

- New: `examples/net-tool/`, as Layout shows.
- `AGENTS.md`: the repository structure lists `examples/net-tool/`, with its `app/`.
- The root `tsconfig.json` and `biome.json` exclude `examples/net-tool/app/`, and `.gitignore` adds its build output.
- The README mentions the tool next to `examples/shop-api`.
- CI: no new job; the suite gains the tests of the rack's side.
- The order of the work: [A test bench for one device](261118_173457-device-test-bench.md) and [Running a rack under another program](261118_173838-running-under-another-program.md) first, since the tool's tests and shell use them; then the rack's side with its tests; then the window and the shell, once Rust and the libraries are installed.

## Confirmation

- The user accepted this decision on 2026-11-18, after reviewing it: "I've reviewed it and I agree. Commit it."
- The user chose the tool, its stack, and its place; the Agent settled the details the user left to it, such as the devices, the window's protocol, and how the shell starts the rack.
