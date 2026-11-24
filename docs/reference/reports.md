# Reports

A running rack reports what it does in five ways: `status()`, `metrics()`, `history()`, `events()`, and the log. `rack ctl` prints the first four as JSON. [Managing a running rack](../guides/managing.md) shows how to reach them.

## status()

`status()` returns one entry per device, bottom slot first, of the type `SlotStatus`. It answers at once, not with a promise:

| Field | What it holds |
|---|---|
| `name`, `model` | The device's name and model. |
| `u`, `height` | Its lowest slot, and how many U it takes. |
| `state` | `"online"`, `"swapping"`, `"degraded"`, `"resetting"`, or `"faulted"`. |
| `firmware` | The firmware hash of the installed instance, or `null` while none is installed. |
| `knownGood` | The hash of the firmware the device falls back to, as [Fallback](../guides/updates.md#fallback) describes. |
| `probationUntil` | While the installed instance is on probation, when probation ends, a millisecond timestamp. |
| `source` | The absolute path of the device file. In an executable, a device of the app names the place of its outside file under the base directory, whether or not the file is there, as [A rack in one executable](../guides/running.md#a-rack-in-one-executable) describes. |
| `packaged` | In an executable, `true` while the device runs the firmware packaged inside it; absent otherwise. |
| `inFlight` | The calls the installed instance is serving, from other devices and from outside the rack. |
| `crashes` | How many times the device crashed within the crash window, watchdog bites included: a number. The window is 60 seconds, or four times the device's longest watchdog timeout when that is longer than 15 seconds, as [Crashes](../guides/faults.md#crashes) describes. A swap that succeeds sets it back to 0. |
| `error` | The last failed swap or crash, as `{ code, message, data? }`. |
| `watchdogs` | The installed instance's watchdogs, the event loop's first, each with its `name`, `timeout`, and `lastFed`. |
| `stuck` | The threads of earlier instances that are stuck in native code, each with its `firmware`, `since`, and the `listeners` it kept. |
| `listeners` | The installed instance's listeners, each with its `url`, `certificates`, `requests` in flight, and open `webSockets`. |
| `owner` | For a copy that serves an `own` need, the instance whose need it serves. |
| `hotplug` | `true` for a device of a [hot-plug directory](../guides/hotplug.md), and for a copy that one owns; absent otherwise. |

## metrics()

`metrics()` resolves with `{ devices, outside }`. `devices` has one entry per device whose installed instance answered, bottom slot first. Each entry has the device name, the `firmware` hash of the instance that counted, `since` (when that instance booted), its event-loop delay `loop`, and counters per member:

```js
{
  device: "orders",
  firmware: "7f3a9c…",
  since: 1763260000000,
  loop: { delayMs: 0.4, maxDelayMs: 12.5 }, // see "Hangs and watchdogs"
  provides: { // per provided port and member
    http: { handle: { kind: "rpc", calls: 812, ok: 809, errors: { RACK_TIMEOUT: 3 }, active: 1, timeMs: 931.2 } },
  },
  needs: { // per need and member
    cache: {
      get: { kind: "rpc", calls: 790, ok: 790, errors: {}, pending: 0, queued: 0, timeMs: 18.4 },
      changed: { kind: "event", received: 12 },
    },
  },
}
```

- For the RPC members a device provides, `calls` counts the calls it served, including calls from `rack.call` and the HTTP panel; `active` counts the ones it is still serving. For the RPC members of its needs, `calls` counts the calls it made; `pending` counts the unfinished ones, and `queued` the ones waiting while the provider is swapped.
- `ok` counts successes and `errors` counts failures by error code, `RACK_TIMEOUT` and `RACK_CANCELLED` included. `timeMs` is the total duration of the finished calls, so `timeMs / (ok + errors)` is the mean.
- An event member a device provides counts `emitted` events and `dropped` deliveries; one it needs counts `received` events.
- A device's counters live in its Worker, which keeps them from the moment its instance boots, so they restart when a device swaps or resets. A device that does not answer within `hookTimeout` is left out.
- `outside` counts the calls from outside the rack, through `call()`, the way a need counts its calls, by address and member:

  ```js
  {
    ports: { // per <device>.<port> and member
      "greeter.greeter": { greet: { kind: "rpc", calls: 812, ok: 805, errors: { RACK_OVERLOADED: 7 }, pending: 0, queued: 0, timeMs: 1250.7 } },
    },
    unrouted: 0, // calls to an address or member that doesn't exist
  }
  ```

  - It includes the calls that the rack answered itself without reaching a device: refused at `queueLimit`, held past their deadline while the device swapped or reset, or sent to a device that was `faulted` or `resetting`.
  - The HTTP panel's calls are calls between devices, so they count under the panel's needs instead, as [HTTP panel](../guides/http.md) describes.
  - The main thread keeps these counters, so they last across swaps and resets. A port's counters start at its first call, and go away when its device is unplugged; a member's go away when a swap removes the member.
- After `stop()`, `metrics()` resolves with no devices and empty `outside` counters.

## history()

`history(name?)` lists the updates of the rack, or of one device, newest first, as `UpdateRecord`s:

```js
{ seq: 12, time: 1763300000000, device: "orders", mode: "restart", cause: "fallback",
  from: "9c1e…", to: "7f3a…", ok: true, error: { code: "RACK_DEVICE_FAULT", message: "…" } }
```

| Field | What it holds |
|---|---|
| `seq` | The number of the record, which increases by one per record while the rack runs. |
| `time` | When the operation that made the update started, a millisecond timestamp. |
| `device` | The device the update replaced, plugged, or unplugged. |
| `mode` | How: `"hot"`, `"cold"`, `"restart"`, `"plug"`, or `"unplug"`. |
| `cause` | What asked for it: the operation, `"reload"`, `"swap"`, `"restart"`, `"rollback"`, `"plug"`, or `"unplug"`, or a `"fallback"`. A device that `reload()` plugs or unplugs has the cause `"reload"`. |
| `from`, `to` | The firmware hash before the update, and the one it installed or tried to install. |
| `ok` | Whether the update succeeded. |
| `error` | Why it failed, or why the device fell back. |
| `group` | For a group replaced together, the `seq` of the group's first record. |

The history keeps at most `historyLimit` records, 256 by default, in memory, and a restart of the rack starts it empty.

## events()

`events(after?)` lists the rack's recent events, oldest first, as `EventRecord`s. They are the events that `subscribe()` delivers, `power`, `swap`, `fault`, and `log`, apart from log entries of level `debug`, so that a device's debugging can't push the other records out. Those entries still go to the logger and to subscribers. A record is the event with two more fields, and a third when it was cut:

```js
{ seq: 214, time: 1763300000000, type: "fault", device: "orders", firmware: "7f3a…",
  error: { code: "RACK_DEVICE_FAULT", message: "orders: instance exited with code 1: …" }, reset: true }
{ seq: 215, time: 1763300000002, type: "log", level: "warn", message: "orders resetting", data: { crashes: 1 } }
```

| Field | What it holds |
|---|---|
| `seq` | The number of the record. The rack numbers its records from 1 each time it starts, one more for each record. |
| `time` | When the rack emitted the event, a millisecond timestamp. A log entry keeps its own `time`. |
| `cut` | `true` for a record that was cut, as below; absent otherwise. |

- With `after`, it lists the records whose `seq` is greater; without it, every record the rack keeps. `after` is a whole number, 0 or more, and another value fails with `RACK_INVALID_INPUT`.
- It answers at once, not with a promise, and still answers after `stop()`.
- The rack keeps the last 1 000 records, in memory: a new one beyond them drops the oldest. A restart of the rack starts the feed empty, from `seq` 1, as it does the history.
- A reader that asks for the records after the last `seq` it read, and gets a first record whose `seq` is greater than that `seq` plus 1, knows that the records between them dropped out before it read them.
- A record holds at most 4 096 characters as JSON. A longer one loses its `data` and its error's `data`, and its message and its error's message are cut to 1 024 characters, the last of them `…`; it then carries `cut: true`. One that is still longer, as when its messages are full of characters that JSON escapes, or its device's name, its error's code, or a swap's `to` runs to thousands of characters, has those texts cut shorter until it fits, and a `to` that isn't a string is cut as its `String()`.
- A record that JSON can't write keeps only its `seq`, `time`, `type`, and device's name, the name cut short when it is long, and carries `cut: true`. Only code that breaks the types makes one, such as code that gives `rollback()` a circular `to`.
- `data` is kept as `--log json` writes it: a `bigint` as a string ending in `n`, such as `"12345678901234567890n"`, and details that JSON can't hold otherwise, such as circular ones, as their `String()`.

The management endpoint serves the same records as the operation `events`, `{ "args": [after?] }`, which `rack ctl events [--after <seq>]` runs.

## The log

Each entry of the log is a `LogEntry`, `{ time, level, device?, message, data? }`. `device` names the device that wrote the entry with `ctx.log`; the rack's own entries have none. The `logger` option of `start()` receives every entry, and `rack start` and `rack dev` print them as text, or as one line of JSON each with `--log json`. As text, control characters, such as a newline or the escape that starts a terminal's command, are escaped as JSON escapes them, so that each entry stays one line, also when its message holds text that a client chose.

The rack's entries that a program or an operator may look for:

| Message | Level | When | `data` |
|---|---|---|---|
| `rack <name> started` | info | Every device is online. | |
| `rack <name> stopped` | info | The rack has shut down. | |
| `control listening` | info | The management endpoint listens. | `address` |
| `listening` | info | A listener of a device listens; `device` names the device. | `url` |
| `listener handed over` | info | A hot swap moved a listener to the new instance. | `url` |
| `listener closed` | info | A listener stopped for good. | `url` |
| `certificates replaced` | info | A listener took new certificates. | |
| `certificates rejected` | error | Changed certificates didn't load at the HTTP panel's second check; the old ones stay. | |
| `<device> powered on`, `<device> powered off` | info | A device started, or stopped. | `firmware` |
| `<device> swapped` | info | A hot swap installed a new instance of the device. | |
| `<device> crashed: <detail>` | error | A device crashed. | |
| `<device> resetting` | warn | The rack resets a device after a crash or a watchdog bite. | |
| `watching <directory> for changes` | info | `rack dev` watches the base directory, and `rack start` the hot-plug directories, which it names as `the hot-plug directories plugins/`. | |
| `hot-plug directory <directory>/ holds <n> device files` | info | At start, for each hot-plug directory: `holds 1 device file` for one, and `doesn't exist` for a directory that doesn't. | |
| `<path> left out: <reason>` | warn | A hot-plug file can't run; at start, and at a reload when the file or the reason changed. | `code` |
| `standard input closed` | info | With `--stop-on-stdin-close`, the rack's standard input closed, and the rack shuts down. | |
| `firmware that nothing needs deleted` | info | At the start of a rack that holds its base directory's management endpoint, it deleted firmware that earlier runs or `rack plan` left. | `files`, how many |
| `dropped a message that the device posted on its Worker's channel` | warn | Device code posted on its Worker's own channel, where the main thread takes only the Worker host's messages. Once per instance: later ones are dropped without a warning. `device` names the device. | |

The other entries are messages for people, and their wording may change.
