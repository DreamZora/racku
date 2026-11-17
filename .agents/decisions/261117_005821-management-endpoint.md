# Decision: Management endpoint and the rack ctl command

Status: accepted

## Background

- The rack handle carries every management operation. P0 has `status`, `metrics`, `reload`, `swap`, `plug`, `unplug`, and `stop`, and the P1 drafts add `restart`, `rollback`, and `history`. Only the code that called `start()` holds the handle.
- A rack run by `rack start` or `rack dev` therefore cannot be operated from outside its process. Under `rack dev` the only way to update a device is to edit its file, and under `rack start` there is no way at all.
- On 2026-11-17 the user asked for an interface to hot reload or restart devices on demand, and set requirements for how to reach it:
  - On Windows, file-based sockets cannot be relied on, so control goes through HTTP or TCP with access authentication, or through another form of inter-process communication.
  - On Linux, a file-based socket is still the better choice, because file permissions control access more simply.
- Windows 10 and later do provide Unix domain sockets. But Bun's support for them there is unverified and cannot be tested on the project's Linux machine.
- Bun can serve and fetch HTTP over a Unix domain socket as well as over TCP (see [Evidence](#evidence)), so the two transports can share one protocol and one implementation.
- [Rack runtime architecture](261112_035942-rack-architecture.md#reliability-and-management) plans a management controller for status and remote operations. It has no decision yet.

## Decision

### Transports

- `rack start` and `rack dev` open a management endpoint, which speaks HTTP and is separate from the panel. Its transport depends on the platform:

| Platform | Transport | Who can connect |
|---|---|---|
| Linux, macOS | Unix domain socket | The user who runs the rack, and root, through file permissions |
| Windows | TCP on `127.0.0.1` | Whoever presents the rack's token |

- `--control-port <port>` of `rack start` and `rack dev`, or `control: { port }` in `start()`, selects the TCP transport on any platform. Tests use it to cover the Windows transport on Linux.
- `start()` opens no endpoint unless asked: `start(manifest, { control: true })`, or `control: { port?, token? }`.
- The endpoint never listens on a network interface other than loopback. Management from other machines belongs to the management controller, which needs its own decision, including transport security.

### The Unix socket

- The socket lives in a directory that only its user can enter, with mode 0700:
  - `$XDG_RUNTIME_DIR/rack42u/` when that variable is set, typically `/run/user/<uid>`, which is private to the user and cleared at logout.
  - Otherwise `~/.local/state/rack42u/control/`.
- The socket file is `<hash>.sock`, where the hash comes from the rack's absolute base directory, so `rack ctl` run in that directory finds it. Its mode is set to 0600 right after it is created.
- Bun creates a socket with the mode the umask allows. Because the directory is private from the start, no other user can connect before the mode is tightened.
- These paths stay short. Socket paths are limited to 108 bytes on Linux and 104 on macOS, and a socket inside a deep app directory could exceed the limit.
- No token is needed: connecting already proves the caller runs as the same user, or as root. Browsers cannot open Unix sockets.
- When the socket file already exists, the rack tries to connect to it:
  - If a rack answers, the new rack refuses to start.
  - If nothing answers, the file is left over from an exited rack, and the new rack replaces it.
- The socket file is removed at shutdown.

### The TCP endpoint

- It listens on `127.0.0.1`, on a free port unless `--control-port` fixes one.
- Each rack generates a random 256-bit token when it starts.
  - Every request must carry it as `Authorization: Bearer <token>`.
  - The rack compares tokens in constant time, and answers 401 without detail when the token is missing or wrong.
- `RACK_CONTROL_TOKEN` in the environment of `rack start` or `rack dev` sets the token instead, for example for a service manager. `start()` takes it as `control.token`.
- The rack writes the endpoint's address and token to a control file, `{ "url", "token", "pid" }`, named like the socket and placed in a directory that only its user can read:
  - On Windows: `%LOCALAPPDATA%\rack42u\control\`, which is private to the user by default.
  - Elsewhere: the same directory as the Unix socket.
- The token never lands in the app directory, so it cannot be committed, synced, or read from a shared project folder. It is never logged; the rack logs the endpoint's address without it.
- The control file is removed at shutdown. When a control file names a process that no longer runs, the next rack replaces it.
- A browser on the same machine can reach `127.0.0.1`, so the TCP endpoint also refuses requests that only a web page would send:
  - It answers only `POST` requests with a JSON body, and 405 to anything else.
  - It answers 403 to a request that carries an `Origin` header. Browsers send `Origin` with every cross-origin `POST`, and command-line clients do not.
  - It answers 403 to a request whose `Host` header is not the address and port it listens on. A page that points its own domain name at `127.0.0.1` still sends its own name as `Host`.
  - It sends no CORS headers.

### The protocol

- Both transports carry the same HTTP protocol, served by the same handler.
- A request is `POST /v1/<op>` with the body `{ "args": [ ... ] }`. Each `op` is one method of the rack handle, with the same arguments and the same result:
  - `status`, `metrics`, `reload`, `swap`, `restart`, `rollback`, `history`, `unplug`, and `stop`.
  - `plug`, whose slot spec travels as `{ source, name?, config? }`.
- Responses:
  - **200:** the operation ran. The body is `{ "ok": true, "value": ... }`, or `{ "ok": false, "error": { "code", "message", "data"? } }` when it failed.
  - **400:** a malformed body or the wrong number of arguments.
  - **401:** a missing or wrong token. TCP only.
  - **403:** an `Origin` header or a foreign `Host` header. TCP only.
  - **404:** an unknown operation.
  - **405:** any method other than `POST`.
- `call` and `subscribe` are not available. The data bus stays with devices and the panel, and streaming rack events can come later.
- Operations from the endpoint share one queue with those from code, so they run one at a time, in call order.
- Every result is plain data, so the management controller can later expose the same operations without changing them.

### The command

```sh
rack ctl status
rack ctl metrics
rack ctl reload
rack ctl swap <device> [source]
rack ctl restart <device> [--no-cascade]
rack ctl rollback <device> [--to <firmware>]
rack ctl history [device]
rack ctl stop
```

- `rack ctl` finds the rack whose base directory is the current directory, or the directory that `--dir <path>` names. It looks for the rack's Unix socket first, and then for its control file.
- `--url <url>` with `--token <token>` or `RACK_CONTROL_TOKEN` reaches a TCP endpoint directly, for example a rack in a container.
- It prints the result as JSON and exits with 0. On failure, it prints the error and exits with 1.

## Evidence

Measured on 2026-11-17 on Bun 1.4.4 and Linux, with probes outside the repository:

- **HTTP over a Unix socket:**
  - `Bun.serve({ unix })` served HTTP, and `fetch(url, { unix })` reached it. The handler saw the method, the path, the JSON body, and `Host: localhost`.
  - The socket was created with mode 775, and `chmod` set it to 600.
  - A second `Bun.serve` on the same path failed with `EADDRINUSE`.
  - Stopping the server removed the socket file.
- **HTTP over TCP:**
  - `Bun.serve({ hostname: "127.0.0.1", port: 0 })` listened on a free loopback port.
  - A request with the right bearer token passed a `timingSafeEqual` check of `node:crypto`. A request that carried a wrong token and an `Origin` header was refused.
  - The server saw the `Host` and `Origin` headers that the client sent.
- **Socket paths:** a socket under the probe's private directory had a 49-byte path. A plausible app directory gave 81 bytes for `.rack/control.sock` inside it, which deeper directories could push past 104.

## Alternatives

- **TCP with a token on every platform, the second draft**: there would be one transport everywhere. But on Linux and macOS, a token stored in a file protects less directly than file permissions on the socket, which the user prefers there.
- **A Unix socket everywhere, the first draft**: file permissions would replace the token. But Bun's support on Windows is unverified.
- **A named pipe on Windows instead of TCP**: the operating system would control access without a token. But named pipes in Bun are unverified on Windows and cannot be tested on the project's machine, while the TCP endpoint can be tested on Linux.
- **The socket in the app directory**: simpler to find. But its path can exceed the socket path limit, and the app directory does not have to be private.
- **Raw TCP with JSON lines**: browsers cannot speak it at all. But it is not a standard protocol, and it would need its own client. The management controller would also have to offer a second protocol. HTTP gets the same protection from the `Origin` and `Host` checks.
- **Management routes on the panel's port**: there would be one port fewer. But the panel may listen on every interface, and its port is meant for application traffic.
- **No authentication on loopback TCP**: simpler. But any local user or process could restart devices, and so could a web page that points its domain name at `127.0.0.1`.
- **Signals, for example `SIGHUP` to reload**: there would be no new transport. But a signal cannot name a device, carry options, or return a result. An interactive `rack dev` would also stop exiting when its terminal closes.
- **Wait for the management controller**: there would be one remote interface instead of two. But operators would have no way to restart a device until then, and the controller can reuse this protocol.

## Impact

- Operators can reload, restart, and roll back devices, read the update history, and stop a rack, all without restarting its process.
- Who can operate a rack:
  - On Linux and macOS, the user who runs it, and root.
  - On Windows, anyone who can read the user's local application data or the rack's environment. That means the same user, or an administrator.
- New public API:
  - The `rack ctl` command, the endpoint's protocol, the socket and control file locations, and the `control` option of `start()`.
  - The `--control-port` flag and `RACK_CONTROL_TOKEN`.
- Tests cover both transports on Linux, the TCP one through `--control-port`. Only the default choice of transport on Windows and the Windows file locations stay untested until the project has a Windows machine.
- Follow-up work once this decision is accepted:
  - The endpoint in a new module, `src/control.ts`, and `rack ctl` in `src/cli.ts`.
  - Tests:
    - each operation through both transports
    - socket and directory modes, and replacing a stale socket while refusing a live one
    - a missing or wrong token
    - `Origin` and foreign `Host` headers
    - loopback binding
    - control file location and removal
    - operations from the endpoint and from code queued in call order
  - A README section on `rack ctl`, and the new module in the `AGENTS.md` layout.

## Confirmation

- The user accepted this decision on 2026-11-17, after setting its transports in review: authenticated HTTP on loopback for Windows, and a Unix socket guarded by file permissions on Linux.
