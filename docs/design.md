# Design

This page says why rack42u is built the way it is: the goals it serves, the main choices it makes, what each choice costs, and the limits that remain. The decision records under [`.agents/decisions/`](../.agents/decisions) hold the full reasoning of each choice, with the alternatives and the measurements behind it.

## Goals

rack42u serves four goals, and when they conflict, the earlier one wins:

1. **Reliability:** the rack keeps serving what it can. Every fault is detected, contained to its device, reported, and recovered from along a defined path.
2. **Maintainability:** each part can be understood, changed, and tested on its own.
3. **Observability:** an operator can see what the rack is doing, what it did on its own, and why.
4. **Extensibility:** builders add capabilities as devices and connectors, without changing the core.

## Principles

From the Linux philosophy:

- Each mechanism does one thing, and composes with the others.
- The rack provides mechanisms, and devices and manifests set policy. The rack bounds calls and times them out, for example, and a device decides whether to retry.
- An existing path is reused before a new one is added: a hung device is reset through the same path as a crashed one.
- State and interfaces are plain data that a person can read: the plan file is text, the log can be JSON, and errors carry codes.
- Options are few, and each has a safe, documented default.

From industrial, automotive, and aerospace engineering:

- **Bounded:** every queue, backlog, retry, record, file, and wait has a fixed limit.
- **Timed:** every wait has a timeout, and every timeout a defined outcome.
- **Contained:** a fault in one device doesn't stop the other devices or the rack.
- **Explicit:** a failure fails fast, with a structured code. Nothing fails silently, hangs, or retries without limit.
- **Supervised:** what can hang is watched, and what can crash is restarted within a limit. A service manager, such as systemd, supervises the rack process itself.
- **Recoverable:** there is a known-good state to return to, and every change can be undone.
- **Deterministic:** fixed limits and explicit states come before adaptive heuristics, so that behavior under faults and overload can be predicted and tested.
- **Validated:** data is checked at every boundary, by the schemas of ports and configurations, and by the checks of manifests and plans.
- **Tested in failure:** the tests inject crashes, hangs, timeouts, overload, and bad updates, not only the paths that work.

## The main choices

### One Worker per device

Bun can't swap code inside one thread reliably: importing a module again runs only that file, while the files it imports stay at their old versions, and the old modules stay in memory. In a measurement, 40 reloads of a module holding 8 MB of state grew the process from 39 MB to 350 MB, with the old modules left in Bun's module cache. A new Worker loads every file fresh, and ending it releases everything its device opened, timers, sockets, and memory included. An uncaught exception ends only the Worker it happened in.

**Cost:** each device takes a Worker, measured at about 3 MB of memory and 4 ms to start, and a call between two Workers takes about 11 µs where a call inside one thread takes 1 µs. In-memory state can't follow a device to a new Worker by itself, so a device that keeps state in memory hands it over with `snapshot` and `restore`.

### The backplane as the only channel

A device that imported another device, or held its objects, could not be replaced without the other. So devices know each other only by addresses and connectors, and the rack can swap, reset, or move any device while the rest keep their links.

**Cost:** data between devices must survive `structuredClone`: no functions, and no class instances, which arrive as plain objects. Errors cross as codes and data. [Devices](guides/devices.md#data-and-errors) gives the rules.

### Links from Worker to Worker

Calls first went through the rack's main thread, which cloned each input and each output twice. That doubled the time of a call, and capped the whole rack at about 61 000 calls per second of 765-byte orders, with the main thread 97% busy. Now the backplane sets up a channel from each consumer's Worker straight to its provider's, and only wires and rewires them: a round trip takes half the time, and the main thread stays free to supervise.

**Cost:** every swap and reset moves links, which the backplane holds and switches in one step, so that no call is lost, as [Updates](guides/updates.md#the-swap-sequence) describes.

### Firmware with a content hash

Each device file builds into one bundle whose hash is its version. A rebuild that changes nothing changes no hash and replaces no device, and a change to a shared file, such as a connector, changes the hash of every device that bundles it. The hashes also name the firmware that the rack falls back to and rolls back to.

**Cost:** a build per device file, which takes milliseconds, and firmware files under `.rack/`, which the rack deletes once nothing needs them.

### Make before break, break before make

A hot swap starts the new instance before the old one stops, so requests keep being answered. Background work does the opposite: it stops on the old instance before it starts on the new one, so two instances never poll the same queue at once. A device that must never run twice, such as one that holds a file lock, declares a cold swap, which stops the old instance first.

**Cost:** during a hot swap, a device runs two instances for a moment, and a device written for it starts its timers in `activate`, not in `powerOn`.

### The gravity rule

A device may depend only on devices below it. That one rule gives the order to start and stop in, rules out cycles of dependencies, and makes the rack's slots a picture of what depends on what.

**Cost:** a lower device that needs to reach an upper one does it with events. A scanned rack works the slots out by itself.

### Fixed bounds instead of breakers

Circuit breakers and adaptive load shedding decide from recent traffic and timing whether to accept a call, which makes overload hard to predict and hard to test. rack42u bounds the calls each need has unfinished, and the events each subscriber has waiting, and fails what goes beyond the bound at once, with a code that is counted. A device that crashes again and again is already isolated by the crash limit. Proxies such as Envoy implement circuit breaking as fixed limits too.

**Cost:** the limits must fit the app, so `queueLimit` can be set per rack. Retrying, waiting, and degrading are up to the devices.

### Supervision that ends in a defined state

Every fault has a path that ends in a known state: a reset, a fallback to known-good firmware, or a `faulted` slot that waits for a swap. Watchdogs turn hangs into resets, a thread stuck in native code keeps its device from starting twice, and an update on probation falls back once if it fails.

**Cost:** a device can end up `faulted` and stay so until an operator acts, and `status()`, the log, and `history()` say why.

### Panels as devices

External connections are held by devices, which open listeners that the rack hands over across swaps with `reusePort`. So the HTTP panel can be replaced like any device, and a device can serve its own port without one.

**Cost:** the handover has limits: WebSockets on a swapped listener close and must reconnect, and a connection queued just as an old listener stops can be reset, as [Listeners](guides/listeners.md#swaps-and-faults) describes.

### No devices on the main thread

The main thread supervises the devices, routes the calls from outside the rack, and answers the management endpoint. A device on it could block its event loop where no watchdog can see it, end the whole rack with an uncaught exception, and keep its old code loaded for good. So every device runs off the main thread, and the main thread never imports device code.

**Cost:** no device can save the hop between threads.

### Bun only

rack42u runs on Bun, which provides Workers, the bundler that builds firmware, HTTP and WebSocket servers, SQLite, and a test runner, and which runs TypeScript as it is. rack42u names a minimum Bun version, which the [README](../README.md#requirements) states, and CI tests it on every system, and the latest Bun release on Linux.

**Cost:** no Node.js or Deno, and Bun's bugs are rack42u's to work around until Bun fixes them.

## Limits

- **JavaScript:** garbage collection pauses the code, each thread runs one event loop, types are checked only where schemas check them, and devices run third-party code. So rack42u gives no real-time guarantees. What it aims for is that every known failure mode has a detection, a bound, a recovery, and a test, and where a guarantee isn't possible, the documentation states the limit.
- **Native code:** a thread blocked in native code, such as a long SQLite query, stops only when the call returns. Only a restart of the rack reclaims a thread whose call never returns, as [Faults and overload](guides/faults.md#stuck-threads) describes.
- **State:** a crash or a restart loses a device's in-memory state. State that matters belongs in a storage device.
- **Bun:** rack42u works around two bugs of Bun 1.4.4: an import that Bun reports missing while the file is on disk is tried again, and a body of 15 KiB or more is sent in a form that Bun writes in one piece, as [`wholeResponse()`](guides/listeners.md#bodies-in-memory) does.
- **Not built yet:** devices in child processes, racks connected to each other, single executables, and a management dashboard, as the [README](../README.md#not-supported-yet) lists.
