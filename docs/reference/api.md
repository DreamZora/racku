# API

## start()

`start(manifest, options?)` starts a rack from its manifest, and resolves with the rack's handle once every device is online. Its options:

| `start` option | Default | Meaning |
|---|---|---|
| `baseDir` | working directory | Where relative paths resolve and `.rack/` is written. |
| `logger` | one line per entry on the console | Receives every log entry. |
| `callTimeout` | 30 000 ms | Timeout of calls that set none. |
| `hookTimeout` | 30 000 ms | Timeout of boot, each lifecycle hook, and each `metrics()` request. |
| `drainTimeout` | 10 000 ms | How long a retiring instance may finish its calls. |
| `probation` | 60 000 ms | How long a new instance may crash before it falls back to known-good firmware; 0 turns fallback off. |
| `historyLimit` | 256 | Most update records `history()` keeps. |
| `watchdog` | 10 000 ms | Timeout of every device's event-loop watchdog, at least 1 000; 0 turns off every watchdog. See [Hangs and watchdogs](../guides/faults.md#hangs-and-watchdogs). |
| `queueLimit` | 10 000 | Most calls a need has unfinished, and most events that wait for one subscriber. See [Overload](../guides/faults.md#overload). |
| `control` | off | Open the management endpoint: `true` for the platform's default, or `{ port, token? }` for loopback TCP. |
| `plan` | `true` | How a scanned rack uses its plan file: `true` follows it, `"update"` rewrites it as `rack dev` does, and `false` neither reads nor writes it. |

## The rack handle

| Method | Purpose |
|---|---|
| `status()` | Each device's slot, height, state, firmware and known-good hashes, probation, calls in flight, recent crashes, watchdogs, stuck threads, and, for a copy, its `owner`. |
| `call(address, method, input, options?)` | Call a port from outside the rack. |
| `swap(name, source?)` | Replace a device now, optionally with another device file. |
| `restart(name, { cascade? })` | Stop a device and start it again from scratch; its direct consumers then reload. |
| `reload(manifest?)` | Rebuild all firmware and replace the devices whose hash changed; with a manifest, also move to its layout. |
| `rollback(name, { to? })` | Go back to earlier firmware that the history keeps. |
| `history(name?)` | List the updates, newest first. |
| `plug(u, slot(...))` / `unplug(name)` | Add a device to a free slot, or remove one that nothing uses. |
| `subscribe(listener)` | Receive power, swap, fault, and log events. |
| `metrics()` | Read each device's call and event counters, and the rack's counters of calls from outside the rack. |
| `stop()` | Shut down from the top down. |
