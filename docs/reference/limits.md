# Limits

Every queue, backlog, retry, record, and wait in racku has a fixed bound, and every timeout a defined outcome. This page lists them, with their defaults and what happens beyond them; the guides that it links to explain each.

## Timeouts

| Timeout | Default | Beyond it |
|---|---|---|
| `callTimeout`, a `start()` option | 30 000 ms | A call that sets no `timeout` fails with `RACK_TIMEOUT`, and is cancelled at its provider. A call whose input streams times out from the end of that stream. |
| `streamTimeout`, a call option | the call's timeout | A stream that moves nothing for so long fails at both ends with `RACK_TIMEOUT`. |
| `hookTimeout`, a `start()` option | 30 000 ms | Boot, a lifecycle hook, or a `metrics()` request that takes longer fails. A stopping instance gets no further hooks, and a thread that hasn't stopped within it of its termination is stuck. |
| `drainTimeout`, a `start()` option | 10 000 ms | Calls still running on a retired instance fail with `RACK_LINK_DOWN`. |
| `probation`, a `start()` option | 60 000 ms | A new instance that crashes or hangs within it falls back to known-good firmware; 0 turns fallback off. |
| `watchdog`, a `start()` option | 10 000 ms, at least 1 000 | A device whose event loop stays blocked for so long is reset; 0 turns off every watchdog. |
| `scope.watchdog(ms)` | at least 1 000 ms | A work loop that doesn't call `feed()` for so long gets its device reset. A watchdog bites between 1 and 1.25 times its timeout after its last feed. |
| `idleTimeout` of a listener | 10 s, from 1 to 255 | The connection closes. Bun applies it in steps of 4 s. |

[Faults and overload](../guides/faults.md) and [Updates](../guides/updates.md) describe what the rack does at each of them.

## Queues and backlogs

| Bound | Default | Beyond it |
|---|---|---|
| `queueLimit`, a `start()` option: calls a need has unfinished, calls from outside the rack per device, and events waiting for one subscriber | 10 000 | A call fails at once with `RACK_OVERLOADED`, which the HTTP panel answers with 503. A subscriber misses the next events, which its provider counts as `dropped`. |
| Requests that wait for a listener's instance | `queueLimit` per listener | They get 503. |
| Unfinished calls of one WebSocket at the HTTP panel | 16 | The panel stops reading the socket, so the client sees backpressure. |

See [Overload](../guides/faults.md#overload).

## Streams

| Bound | Value | Beyond it |
|---|---|---|
| Bytes of a stream in flight | 256 KiB | The sender reads its source no faster than the reader takes chunks. |
| A piece of a stream | 1 MiB | A larger chunk arrives as several pieces. |
| Streams of a need | bounded by its unfinished calls, at most `queueLimit`, each with up to 256 KiB, or one piece of up to 1 MiB, in flight | About 2.4 GiB per need and direction with the defaults, and up to 9.8 GiB in pieces of 1 MiB. |

See [Streams](../guides/data.md#streams).

## Listeners

| Bound | Default | Beyond it |
|---|---|---|
| Listeners of an instance | 16 | `ctx.serve()` fails, and the device's `powerOn` with it, with `RACK_HOOK_FAILED`. |
| `maxRequestBodySize` | 1 MiB | Bun answers 413. |
| `websocket.maxPayloadLength` | 1 MiB | The WebSocket closes with 1009. |
| `websocket.maxBuffered`, bytes unsent to a WebSocket | 1 MiB | The WebSocket closes with 1013. |
| Servers of a listener after `setTls()` | 2 | A further `setTls()` closes the WebSockets opened before the previous one, with 1012. |

See [Listeners](../guides/listeners.md).

## The HTTP panel

| Field or bound | Default | Beyond it |
|---|---|---|
| `maxBodySize` | 1 MiB | 413. |
| `streamThreshold`: the largest request body that goes to the device whole, with a declared length or chunked | 256 KiB | The body streams. |
| `idleTimeout` | 10 s, from 1 to 255 | An idle connection closes; a body sent whole that hasn't arrived fails with 408, as does a chunked body that neither ends nor passes `streamThreshold`. |
| The average rate of a body that streams, over the time that the panel waits for the client, once its first `idleTimeout` has passed | at least 1 KiB/s; not configurable | 408, and the call is cancelled. |
| `certificateCheck`: how often the panel reads its certificate files | 60 s, from 1 to 3 600 | |
| `webSocket.maxMessageSize` | 1 MiB | The WebSocket closes with 1009. |
| `webSocket.maxConnections`, WebSockets open or being upgraded | 10 000 | Upgrades get 503. |
| Bytes unsent to a WebSocket client | 1 MiB | The client is closed with 1013. |
| The panel's check of its sockets | every 30 s | |
| A panel instance that makes no call to a device | 90 s | At its next call, the device runs its `close` handler for that panel's sockets, with 1006. |
| `httpHandler`'s `streamThreshold`: the largest response body that goes back whole | 16 MiB | The body streams. |
| Upgrades that `httpHandler` accepted and whose sockets haven't opened | 10 000, each for 10 s | The oldest is forgotten; its socket opens without its `data`. |
| Warnings of the panel for one code and route target, or for slow bodies | 1 a minute | The next one says how many came since. |

See [The HTTP panel](../guides/http.md).

## Supervision and history

| Bound | Value | Beyond it |
|---|---|---|
| Crashes, watchdog bites included | more than 3 within 60 s, or within four times the longest watchdog timeout when that is longer than 15 s | The slot is `faulted` until a swap succeeds. |
| Armed watchdogs of a device | 16 | `scope.watchdog()` throws a `RangeError`. |
| Fallbacks per update, a start in an executable included | 1 | |
| `historyLimit`, a `start()` option: update records | 256 | The oldest records go. |
| Firmware bundles under `.rack/firmware/` | those that an instance, a known-good firmware, or a kept record needs | The rack deletes the others. |
| Imports of a firmware bundle that Bun reports missing while it is on disk | 4 attempts, 10 ms apart | The error of the last one. |
| Builds of firmware whose relative imports Bun reports missing while their files are on disk | 4 attempts, 10 ms apart | The error of the last one. |

See [Faults and overload](../guides/faults.md) and [Updates](../guides/updates.md#history).

## Executables

| Bound | Value | Beyond it |
|---|---|---|
| Starts of a rack in an executable | One, and one more for each outside file that fails while the rack starts, which then starts from its packaged firmware | The rack fails to start, as under `rack start`, when a packaged firmware fails. |
| Builds of outside files | One per device at start, and at each `reload()` or `swap(name)`, with no timeout of its own, as under `rack start` | |
| The executable's size | About 100 MiB on Linux x64, most of it Bun's runtime | |

See [A rack in one executable](../guides/running.md#a-rack-in-one-executable).

## Watching

`rack dev`, and an executable with `--watch`, watch the base directory and reload the rack after changes; `rack start` watches it for changes in its hot-plug directories.

| Bound | Value | Beyond it |
|---|---|---|
| Watches | Two: a recursive watch of the base directory, and one of its parent, which notices the base directory's own removal on every system | A watch of the base directory that can't start, such as at the system's limit of watches, logs `cannot watch <dir>`, and the rack runs on: changes apply at `ctl reload`. A parent that can't be watched logs a warning, and the base directory's watch goes on. |
| The wait before a reload | 100 ms after the last change, and at most 1 s after the first | |
| Reloads | One at a time, and one more waiting, which applies the changes made during the one that runs | |
| Builds per reload | One per device file, as at `ctl reload` | |

See [Hot reload with rack dev](../guides/running.md#hot-reload-with-rack-dev) and [A rack in one executable](../guides/running.md#a-rack-in-one-executable).

## Hot-plug devices

| Bound | Value | Beyond it |
|---|---|---|
| Hot-plug devices | The rack's `size`, less what the fixed instances take | The hot-plug devices that come last in the order of placement are left out. |
| Devices that an every need reaches | Those below its device, fewer than the rack's `size` | |
| Calls that wait for one device of an every need | `queueLimit`, for each device on its own | A call fails at once with `RACK_OVERLOADED`. |
| `changed()` calls | One for each change of what an every need reaches | |
| Commands of one device | 256, each named with 1 to 64 letters, digits, `.`, `_`, and `-`, from a letter | `commands()` throws `RACK_INVALID_INPUT`, and the device fails to power on. |
| Log entries about a file that is left out | One at each start, and one when the file or the reason changes | |
| The watch of `rack start` | As for `rack dev`, in [Watching](#watching) | |

See [Hot-plug devices](../guides/hotplug.md).

## The bench

| Bound | Value | Beyond it |
|---|---|---|
| Records of `calls`, `events`, `logs`, and `faults` | the last 10 000 each | `dropped` counts the older ones. |
| A stream in a call to a stub | 16 MiB, read whole | The call fails with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`. |

See [Testing a device](../guides/testing.md).
