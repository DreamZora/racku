# Managing a running rack

## rack ctl

`rack start` and `rack dev` open a management endpoint, and `rack ctl` operates the rack through it:

```sh
rack ctl status                          # each device's slot, state, and firmware
rack ctl metrics
rack ctl reload
rack ctl swap <device> [source]
rack ctl restart <device> [--no-cascade]
rack ctl rollback <device> [--to <firmware>]
rack ctl history [device]
rack ctl stop                            # shut down in order, like Ctrl-C
```

`rack ctl` finds the rack whose base directory is the current directory, or `--dir <path>`, even when the rack and `rack ctl` reach that directory by different paths, such as through a symlink. It prints the result as JSON and exits with 0, or prints the error and exits with 1.

## Who can connect

Nothing listens on the network.
- On Linux and macOS, the endpoint is a Unix socket in a directory that only your user can enter: `$XDG_RUNTIME_DIR/racku/`, or `~/.local/state/racku/control/`. Only your user and root can connect.
  - A socket left behind by a rack that crashed is replaced.
  - While a rack answers on the socket, a second rack for the same directory refuses to start.
- With `--control-port <port>`, and by default on Windows, the endpoint listens on loopback TCP, `127.0.0.1`.
  - Every request needs the rack's token as `Authorization: Bearer <token>`. The token is random on each start, unless `RACK_CONTROL_TOKEN` sets it.
  - The rack writes the address and the token to a control file in the same private directory. On Windows, that directory is `%LOCALAPPDATA%\racku\control\`.
  - The endpoint refuses requests that carry an `Origin` header or a `Host` other than its own, so a web page cannot drive it.
  - `rack ctl --url <url> --token <token>` reaches such a rack from anywhere on the machine.

## The protocol

Each operation is `POST /v1/<operation>` with the body `{ "args": [...] }`, and runs the rack-handle method of the same name.
- It answers `{ "ok": true, "value": ... }`, or `{ "ok": false, "error": { code, message } }`.
- `plug` takes its slot spec as `{ source, name?, config? }`.
- Operations from the endpoint and from code share one queue, so they run one at a time, in call order.

From code, `start(manifest, { control: true })` opens the same endpoint.
