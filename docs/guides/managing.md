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
rack ctl events [--after <seq>]          # the rack's recent events, such as crashes
rack ctl stop                            # shut down in order, like Ctrl-C
```

`rack ctl` finds the rack whose base directory is the current directory, or `--dir <path>`, even when the rack and `rack ctl` reach that directory by different paths, such as through a symlink. It prints the result as JSON and exits with 0, or prints the error and exits with 1.

## Who can connect

Nothing listens on the network.
- On Linux and macOS, the endpoint is a Unix socket in a directory that only your user can enter: `$XDG_RUNTIME_DIR/racku/`, or `~/.local/state/racku/control/`. Only your user and root can connect.
  - The rack opens its endpoint only in a directory that is a real directory, not a link, that your user owns, and whose mode is 0700 once the rack has set it. Otherwise the start fails with `RACK_MANIFEST`, saying what is wrong. An empty or relative `XDG_RUNTIME_DIR` or `XDG_STATE_HOME` counts as unset.
  - A socket left behind by a rack that crashed is replaced.
  - While a rack answers on the socket, a second rack for the same directory refuses to start, and so it does when something accepts on the socket but doesn't answer within 5 s.
- With `--control-port <port>`, and by default on Windows, the endpoint listens on loopback TCP, `127.0.0.1`.
  - Every request needs the rack's token as `Authorization: Bearer <token>`; the token alone gets 401. The token is random on each start, unless `RACK_CONTROL_TOKEN` sets it, which needs 32 characters or more: a shorter one, an empty one included, fails the start with `RACK_MANIFEST`.
  - The rack writes the address and the token to a control file in the same private directory, as a new file of mode 0600 that it renames into place. On Windows, that directory is `%LOCALAPPDATA%\racku\control\`.
  - The endpoint refuses requests that carry an `Origin` header or a `Host` other than its own, so a web page cannot drive it.
  - `rack ctl` sends the token of a control file only while the process that the file names runs. For a rack that ended, it says that no running rack has the base directory, and sends nothing to whatever listens on the port now.
  - `rack ctl --url <url>` reaches such a rack from anywhere on the machine, with the token on the first line of `--token-file <file>`, or else in `RACK_CONTROL_TOKEN`. No flag takes the token itself, since every user on the machine can read a command line.

## The protocol

Each operation is `POST /v1/<operation>` with the body `{ "args": [...] }`, and runs the rack-handle method of the same name.
- It answers `{ "ok": true, "value": ... }`, or `{ "ok": false, "error": { code, message } }`.
- `plug` takes its slot spec as `{ source, name?, config? }`.
- Operations from the endpoint and from code share one queue, so they run one at a time, in call order.

From code, `start(manifest, { control: true })` opens the same endpoint.

## The dashboard

`rack dashboard` shows the rack that runs from the current directory, or `--dir <path>`, in the browser, and runs operations on it:

```sh
rack dashboard
# dashboard of /srv/shop-api at http://127.0.0.1:43117/#token=…
```

Open the URL that it prints. The page reads the rack every second, and its counters every 2 seconds, and shows:
- the rack: how many devices are in each state, the calls from outside per second, and how old what it shows is; while the rack doesn't answer, since when and why;
- the rack's front, with each device in its slots, and its state as a word and an icon. Select a device for its details: everything `status()` reports, its calls and errors per second, the mean duration of its calls, its event loop's delay, a chart of its calls over the last 2 minutes, and its updates;
- the calls from outside the rack, the history of updates, and the rack's recent events, which `events()` keeps, narrowed to a level or a device.

Buttons run Reload and Stop for the rack, and Swap, Restart, and Roll back for a device. Each asks first, and shows its outcome; the rack runs them in its queue, with those of `rack ctl`. A swap rebuilds the device's own file: plugging, unplugging, and a swap to another file stay with `rack ctl` and code.

The dashboard is a process of its own, which reaches the rack as `rack ctl` does, and the rack opens nothing new for it. It goes on while the rack stops and starts again. [Flags of rack dashboard](../reference/cli.md#flags-of-rack-dashboard) lists its flags, such as `--url` for a rack's TCP endpoint, and an executable serves its own with `dashboard`.

Who can use it:
- The URL holds a token, new at each start, in its fragment, which the browser doesn't send to the server; the page keeps it in its tab. Whoever has the URL can do through the page what `rack ctl` does, so keep it as secret as the rack's control token. A log that receives the dashboard's output, such as a service manager's, holds the URL too.
- The dashboard listens on `127.0.0.1` only, and refuses the requests that pages of other sites send. From another machine, forward a port, such as with `ssh -L 8080:127.0.0.1:43117 <host>`, and open the URL with `localhost:8080` in place of `127.0.0.1:43117`.
- [Limits](../reference/limits.md#the-dashboard) gives its bounds.
