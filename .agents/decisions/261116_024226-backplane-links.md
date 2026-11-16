# Decision: Backplane protocol with direct links between devices

Status: accepted

## Background

- [Backplane protocol, error model, and fault handling](261112_043035-backplane-protocol.md) sends every data-bus message through the rack main thread. A call from one device to another goes from the caller's Worker to the backplane and from there to the provider's Worker, and the result returns the same way. Every hop is a structured clone, so one call clones its input twice and its output twice, and the main thread deserializes and re-serializes both.
- On 2026-11-16 the user judged these four copies too expensive and asked to cut the cost.
- Measured on Bun 1.4.4 through the rack42u backplane (see [Evidence](#evidence)):
  - A round trip between two devices takes 25 µs for a tiny payload, 47 µs for one 765-byte order, and 18.9 ms for 1024 orders (740 KB). A bare `MessageChannel` between the two Workers takes 11 µs, 22 µs, and 8.6 ms for the same payloads.
  - The main thread spends 4.5 µs of CPU on every tiny call and 16 µs on every 765-byte call. At about 61,000 calls per second of 765-byte orders it is about 97% busy, so that rate is the ceiling for all calls between devices in the rack combined, and the HTTP panel competes for the same thread.
- This decision replaces the backplane protocol decision. Boot and FRU, where validation happens, the error model, and the fault policy carry over; channels, routing, timeouts, events, pausing, and draining change.

## Decision

### Links

- A **link** is a `MessageChannel` that connects one need of a consumer instance to the provider port it is wired to, in the instance installed in the provider slot. The backplane creates every link and sends each end to its Worker over the control channel. Device code never sees links; the Worker host owns them.
- Calls, results, cancellations, subscriptions, and events between devices travel on links. The main thread does not see this traffic: each message is cloned once and crosses one thread boundary.
- The backplane remains the only communication channel between devices: it decides which links exist and replaces them whenever instances change, but it no longer relays each message.

### Channels

- Each Worker has three kinds of channels:
  - **Control channel**: the Worker's own `postMessage`, carrying power bus and management bus messages: boot, lifecycle hooks, logs, and link management. It is request-response: each request carries an `id`, and the Worker replies with the same `id` using `{ ok: true, value }` or `{ ok: false, error }`.
  - **Data channel**: a `MessagePort` passed in at boot, carrying calls from outside the rack (`rack.call` and the panel), their results, and their cancellations.
  - **Links**: one per wire, carrying the data bus between devices.

### Boot and FRU

- After creating a Worker, the main thread sends a `boot` message that contains: the firmware file URL, slot information, configuration, base directory, the default call timeout, and the data channel port.
- On receipt, the Worker performs the following in order:
  1. Loads the firmware and confirms that the default export is a device definition.
  2. Validates the configuration.
  3. Replies with FRU information: model, height, `needs` and `provides` (the connector `id`, member names, and member types of each port), and whether it implements `snapshot`/`restore`.
- Up to this point only the top-level code of the device module has run, and `powerOn` has not been called.
- Before `powerOn`, the backplane gives the instance one link per need, to the instance installed in the provider slot, so the instance can call its needs from `powerOn` on.

### Wiring and routing

- Wiring is a slot-level mapping: `(consumer device, need) → (provider device, port)`. Wiring is determined when a device is plugged in and stays unchanged across a swap.
- Wiring follows these rules:
  - When `patch` specifies it, connect according to `patch`.
  - Without `patch`, look for a port with the same connector `id` among devices in lower slots; when exactly one is found, connect automatically, and when none or several are found, the assembly fails.
  - The provider must be below the consumer (gravity rule).
- Every link ends at the instance currently installed in the provider slot. Whenever the instance installed in a slot changes, the backplane replaces the links of every consumer wired to that slot.
- A slot switches from an old instance to a new one in one step, in two phases:
  1. **Hold**: the backplane tells every consumer wired to the slot to hold its link, and every provider of the slot's needs to hold the events addressed to the slot. A holding consumer queues new calls for that need; a holding provider queues those events. The backplane holds calls from outside the rack in its own queue. Every party sends a hold marker on the link before it confirms.
  2. **Switch**: once every party has confirmed, the backplane gives every consumer a new link to the new instance. The consumer sends its current subscriptions and then its queued calls on the new link, in order. Providers send their queued events to the new instance and stop sending events to the old one, and the backplane routes calls from outside the rack to the new instance. The old instance keeps its own need links until it retires, so it can still call its needs while it finishes its calls.
- When the swap hands over state, the hold starts before the old instance drains and covers `snapshot` and `restore`. Otherwise it starts after the new instance runs `activate`. Either way, no instance receives a new call while another one in the same slot still can.
- Calls sent on a replaced link before its hold marker finish on the old instance.
- Callers outside the rack (`rack.call` and the panel) address `<device>.<port>` directly and do not go through the wiring table. The backplane forwards each such call over the data channel to the instance installed at that moment.
- During a swap, ports referenced by panel routes are treated the same as wired ports: they must not disappear, and they must not change their connector.

### RPC

- The caller's Worker host sends a `call` message on the link that contains: the call ID, unique per link; the member name; the input; and the deadline (`Date.now() + timeout`). The provider knows the caller's address from the link.
- The default timeout is 30 seconds. The side that sends the call into another thread owns its timeout: the caller's Worker host for calls on links, and the backplane for calls from outside the rack. When the timeout fires, that side rejects the call with `RACK_TIMEOUT` and sends `cancel` to the provider at the same time.
- When the caller cancels on its own initiative, the call is rejected locally with `RACK_CANCELLED` immediately, and `cancel` goes to the provider.
- When the provider receives `cancel` or reaches the deadline, it aborts the `call.signal` passed to the implementation function.

### Where validation happens

- The backplane does not do schema validation; it never sees the payloads on links.
- Validation happens at the following places:
  - The provider validates RPC input and output in its own Worker.
  - The publisher validates event payloads.
  - The Worker validates the configuration at boot.
- Invalid input returns `RACK_INVALID_INPUT`, and invalid output returns `RACK_INVALID_OUTPUT`.

### Events

- A consumer subscribes and unsubscribes with `sub` and `unsub` messages on its link; the provider's Worker host records the subscriptions of each link.
- When a device emits an event, its Worker host sends the event on every live link whose consumer subscribed to it, so each subscriber receives one clone.
- A link carries events only while the instances at both of its ends are installed:
  - An instance in standby is not installed. Its need links carry its calls but no events to it. It has no consumer links yet, so the events it emits are dropped and a warning is logged.
  - While a slot is held, its providers queue the events addressed to it. After the switch they deliver the queued events to the new instance in order, limited to the events that instance subscribed to.
  - After a switch, a consumer ignores events that arrive on the link it replaced.
- Delivery is at most once. On one link, events and results arrive in the order the provider sent them.

### In-flight calls, holding, and draining

- Each Worker host counts the calls it is serving, from links and from its data channel.
- Holding replaces the pause of the earlier protocol. Queues live with each holding consumer (per link), with each holding provider (per held slot, for events), and with the backplane (per slot, for calls from outside the rack). Each queue holds at most 10000 entries. Beyond that limit, new calls fail with `RACK_LINK_DOWN` and new events are dropped.
- Draining: the backplane asks the instance over the control channel to report when every held link to it has delivered its hold marker and it is serving no calls, and waits at most `drainTimeout` (default 10 seconds). After the timeout, the backplane has the consumers that hold links to the instance fail the remaining calls with `RACK_LINK_DOWN`, does the same for calls from outside the rack, and powers the instance off.

### Error model

- Errors passed across the backplane are uniformly `{ code, message, data? }`, which in JavaScript appears as a `RackError` with `code` and `data` properties.
- Errors travel on the wire as plain objects and are restored to `RackError` on receipt. The reason is that `Error` loses its custom properties after structured clone.
- When input cannot be cloned, the caller returns `RACK_INVALID_INPUT` locally. When output cannot be cloned, the provider returns `RACK_INVALID_OUTPUT`.
- Framework error codes start with `RACK_`:
  - `RACK_TIMEOUT`, `RACK_CANCELLED`: timeout, cancellation.
  - `RACK_LINK_DOWN`: the provider is not online or has been powered off.
  - `RACK_NO_ROUTE`: the address does not exist, or the member does not exist.
  - `RACK_INVALID_INPUT`, `RACK_INVALID_OUTPUT`, `RACK_INVALID_CONFIG`: the corresponding validation failure.
  - `RACK_DEVICE_FAULT`: the device threw an exception that is not a `RackError`, or the instance crashed.
  - `RACK_MANIFEST`: the manifest or the assembly is invalid.
  - `RACK_SWAP_REJECTED`: the swap compatibility check failed.
  - `RACK_HOOK_FAILED`: a lifecycle hook failed or timed out.
- A `RackError` thrown by a device is passed to the caller unchanged. A device may use its own error codes, but they must not start with `RACK_`.
- Any other exception thrown by a device is converted to `RACK_DEVICE_FAULT`, with the original error message preserved.
- `data` must be structured-cloneable, otherwise it is dropped.

### Faults and resets

- When a Worker exits, as long as the rack did not terminate it deliberately, the instance is always judged to have crashed, whatever the exit code is. The reason is that an exit caused by an unhandled Promise rejection also has exit code 0, the same as a normal termination.
- When an instance exits, the backplane marks its links down:
  - Every consumer that holds a link to it fails the calls pending on that link, with `RACK_DEVICE_FAULT` after a crash and `RACK_LINK_DOWN` after a deliberate termination. Until the backplane sends a new link, new calls for that need fail with `RACK_LINK_DOWN`.
  - Every provider the instance had links to aborts the calls it is serving for the instance and drops those links.
  - Calls from outside the rack that the instance was serving fail the same way.
- After a crash, the device resets automatically from the same firmware: a new instance is created, and `powerOn`, `selfTest`, and `activate` run in order, after which consumers receive links to it. A reset does not keep in-memory state.
- When the device crashes more than 3 times within 60 seconds, resets stop and the slot is marked as faulted. Calls sent to it afterward return `RACK_LINK_DOWN` until a swap succeeds.
- The following errors are only logged and do not crash the device: errors thrown by timers managed by the rack (`scope.every`/`scope.after`), and errors thrown by event handlers.

## Evidence

### Copy cost

Measured on 2026-11-16 on Bun 1.4.4, Linux, 32 cores. The probe scripts lived outside the repository.

- The provider echoes its input. "One order" is an object with a customer, 8 items, and 2 tags; the lists repeat it. "Sequential" is one call at a time; "pipelined" keeps 32 calls in flight. Main-thread CPU comes from `/proc/self/task/<pid>/stat`, whose resolution is 10 ms per run, so 0 means below resolution.
- Bare transports, without rack42u code. Relay is the path the backplane takes today. The pre-serialized relay sends the payload as a `bun:jsc` `serialize` buffer and the main thread forwards only an envelope. The channel per call sends the payload on a new `MessageChannel` whose end travels through the relay.

  Sequential round trip, in µs:

  | Payload | Size | Relay | Direct link | Pre-serialized relay | Channel per call |
  |---|---:|---:|---:|---:|---:|
  | `{ n: 1 }` | 15 B | 22.0 | 10.6 | 25.6 | 20.7 |
  | One order | 765 B | 40.6 | 21.5 | 38.9 | 31.0 |
  | 64 orders | 44 KB | 1,038 | 485 | 499 | 488 |
  | 1024 orders | 740 KB | 17,722 | 8,586 | 8,721 | not run |
  | `Uint8Array` | 1 MB | 663 | 271 | 491 | 301 |
  | String | 1 MB | 115 | 78 | 523 | not run |

  Pipelined calls per second, with main-thread CPU µs per call in parentheses:

  | Payload | Relay | Direct link | Pre-serialized relay | Channel per call |
  |---|---:|---:|---:|---:|
  | `{ n: 1 }` | 285,322 (3.0) | 466,020 (0) | 211,995 (3.5) | 139,530 (4.5) |
  | One order | 76,187 (12) | 142,675 (0) | 85,091 (8) | 81,786 (7) |
  | 64 orders | 1,937 (510) | 3,825 (0) | 4,000 (20) | 3,926 (10) |
  | 1024 orders | 113 (8,667) | 227 (0) | 228 (0) | not run |
  | `Uint8Array`, 1 MB | 2,238 (400) | 4,579 (0) | 4,327 (100) | 3,553 (0) |
  | String, 1 MB | 33,273 (33) | 45,439 (0) | 4,011 (100) | not run |

- Through the rack42u backplane at commit `a560600`, with the echo device in U1 and the calling device in U5:

  | Payload | Provider schema | Sequential µs | Pipelined calls/s | Main-thread CPU µs per call |
  |---|---|---:|---:|---:|
  | `{ n: 1 }` | `v.unknown()` | 25.2 | 191,326 | 4.5 |
  | One order | `v.unknown()` | 46.6 | 60,720 | 16 |
  | One order | valibot object | 52.4 | 61,322 | 16 |
  | 64 orders | `v.unknown()` | 1,065 | 1,765 | 560 |
  | 64 orders | valibot array | 1,293 | 1,755 | 570 |
  | 1024 orders | `v.unknown()` | 18,882 | 107 | 9,333 |
  | `Uint8Array`, 1 MB | `v.unknown()` | 815 | 1,892 | 533 |
  | String, 1 MB | `v.unknown()` | 124 | 27,199 | 33 |

- Provider-side validation adds 5.8 µs per call for one order and 228 µs for 64 orders, because valibot builds new output objects. That cost stays in the provider whatever the transport.
- `bun:jsc` `serialize` returns a `SharedArrayBuffer`, also when `binaryType: "arraybuffer"` is passed, and `node:v8` `serialize` produces the same bytes. Like `postMessage`, it throws `DataCloneError` for functions and drops class prototypes.

### Links on Bun 1.4.4

Measured on 2026-11-16 on the same machine, with probe scripts outside the repository.

- A probe created a `MessageChannel` on the main thread, transferred its two ends to two Workers, exchanged 20 messages between them, and then ended the Workers in six ways: the main thread terminated either Worker mid-traffic, one Worker called `process.exit`, the main thread terminated both, it terminated both after the traffic, or the surviving Worker posted 50 messages to a link whose peer had already been terminated. Three runs of 240 cycles each completed without a crash or a hang.
- Messages posted on one end before the other end reached its Worker were delivered after the transfer, 5 of 5.
- When the peer Worker was terminated, the surviving end received a `close` event in each of the 40 cycles that checked for it, and posting to it did not throw.

### Worker faults and cloning

Carried over from the earlier backplane protocol decision; measured on 2026-11-12 on Bun 1.3.13 on the same machine.

- After an uncaught exception is thrown in a Worker timer, the Worker fires `error` and `close` (code 1), and a later call to `postMessage` throws "Worker has been terminated".
- An unhandled Promise rejection likewise fires `error` and `close` (code 0) and terminates the Worker.
- Calling `preventDefault()` in the `error` event cannot prevent the Worker from being terminated.
- After the main thread calls `terminate()`, the Worker fires `close` with code 0. After `process.exit(3)` is called inside the Worker, it fires `close` with code 3.
- After structured clone, `Error` is still an `Error` instance and keeps `message`, but custom properties such as `code` and `data` are lost.
- Functions cannot be cloned and throw `DataCloneError`. A cloned class instance loses its prototype.
- A `MessagePort` can be passed to a Worker through the transfer list of `postMessage`.

## Alternatives

- **Keep relaying every message through the main thread**: it is the simplest protocol, but each call between devices is cloned four times, and the main thread caps the throughput of all such calls in the rack, at about 61,000 calls per second for 765-byte payloads.
- **Relay pre-serialized payloads**: the sender serializes the payload with `bun:jsc` into a `SharedArrayBuffer`, and the main thread forwards only a small envelope. The protocol would stay as it is and large object graphs would cost what a direct link costs. But small calls get slower than today (25.6 µs against 22.0 µs), 1 MB strings get 4.5 times slower, the main thread still handles every call, and the protocol would depend on a JavaScriptCore-specific module.
- **Open a channel per call**: the payload travels on a new `MessageChannel` whose end the backplane routes like a call today, so routing per call stays. Creating and transferring a port for every call costs more than the copies it saves on small calls (139,530 against 285,322 calls per second), and the main thread still handles every call.
- **Switch consumers one at a time without holding**: no call ever waits during a swap, but for a moment both instances receive new calls, which breaks the one-step switch that [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) requires.
- **Move only calls to links and keep events on the main thread**: event handling would stay unchanged, but a result could overtake an event the same provider emitted before it, an order the relay keeps today, and every event would still cost two clones per subscriber.
- **Transfer binary payloads instead of copying them**: only `ArrayBuffer`s benefit, and a transfer detaches the caller's buffer, which changes what device code sees. It can be added later on top of links as an explicit call option.
- **Shared-memory ring buffers with `Atomics`**: they could cut latency below `MessagePort`, but they need their own framing, flow control, and wake-ups, and they still pay for serializing objects. They are not worth it before links have been measured in use.

## Impact

- Calls between devices clone each payload once in each direction instead of twice, cross one thread boundary in each direction instead of two, and cost the main thread nothing per call. Their throughput then grows with the number of Workers instead of stopping at the main thread's limit.
- Calls from outside the rack (`rack.call` and the panel) start on the main thread, so they already crossed only one thread boundary in each direction; their path does not change.
- Each swap holds calls to the slot for one control round trip to its consumers and providers, plus the handover itself when there is one.
- The timeout of a call between devices moves from the backplane into the caller's Worker host. The provider still aborts `call.signal` at the deadline the call carries.
- The main thread no longer sees calls between devices. The planned breaker, thermal, and management controller must collect call counts and queue lengths from the Worker hosts over the management bus.
- `MessagePort` links work between threads of one process. The future `chassis` form and the top-of-rack switch must end their links on the main thread and bridge them to their own transport; each needs its own decision.
- [Rack runtime architecture](261112_035942-rack-architecture.md) notes in its `## Impact` that the backplane "adds one routing hop even within the same process". Links remove that hop. That decision stays as it is: its rules still hold, because the backplane still decides every connection between devices, and this note records the change.
- Follow-up work once this decision is accepted:
  - Implement links in `src/worker.ts`, `src/backplane.ts`, `src/instance.ts`, `src/rack.ts`, and `src/protocol.ts`.
  - Mark the backplane protocol decision superseded, and point its 23 `@decision` references in 12 files to this decision.
  - The existing backplane, swap, reset, and panel tests must pass unchanged. New tests pin what links add: calls between devices complete while the main thread is blocked; a held slot receives no call until the switch, and its queued calls arrive in order; pending calls fail when a provider crashes; an instance in standby receives no events.
  - Rerun the end-to-end benchmark from [Evidence](#evidence) and record its results in `## Implementation`.
  - Add "link" to the terminology table in `AGENTS.md`.

## Implementation

- Messages: `src/protocol.ts`. The control requests that manage links are `link`, `hold`, `release`, and `down` for a need, and `attach`, `holdEvents`, `live`, and `drop` for a provided port. `installed`, `drain`, and `metrics` cover the rest.
- The backplane: `Backplane` in `src/backplane.ts`. `connect` links a new instance's needs, `install` switches a slot to an instance, `hold` and `release` hold and release a slot, `drain` and `fail` drain an instance or fail its calls, and `disconnect` handles exits. Calls from outside the rack keep their per-call routing there.
- The Worker side: `src/worker.ts`. It covers outgoing calls with their timeouts and hold queue, the provider ends of links, event fan-out with per-consumer hold queues, hold markers, and drains.
- The main-thread handle: `Instance` in `src/instance.ts`. It sends control requests with `request`, drains with `drain` (both the markers and the calls from outside the rack), and reads `serving`.
- `#link` in `src/backplane.ts` sends both ends of a link at once and decides the hold state at that moment. A link to an instance that is held carries the token of that hold, so its consumer queues calls and sends a marker on it first. A request that times out still arrives later, in order, so a timeout never undoes a link; only an exit removes one.
- Each hold remembers every provider it asked to queue events, and `release` and `install` end the queue at all of them, including providers that no longer have a link to the slot.
- The rack: cold start, `swap`, reset, `plug`, and retirement call the backplane in `src/rack.ts`. Every swap holds the slot before it installs the new instance.
- A new instance that exits while the hold before the switch waits is not installed: the swap rolls back with `RACK_SWAP_REJECTED`. An installed instance that exits while its slot is busy, during `install` or the retirement of the old instance, is reset once the swap or the running reset gets to it.
- `status().inFlight` reads a counter that the Worker keeps in a `SharedArrayBuffer`, so it includes calls on links.
- A call that waits in a hold queue is cloned when it is queued, so it carries its input as it was when the device made the call.
- Tests: `test/links.test.ts`, with fixture devices `test/fixtures/devices/pump.ts`, `busy.ts`, and `client.ts`. Its "links through crashes and busy instances" tests cover five races found in review; each of them fails when its fix is taken out. The existing backplane, swap, reset, and panel tests pass unchanged apart from their `@decision` references. The test that calls between devices while the main thread is blocked fails against the earlier relay at commit `a560600`.
- End-to-end benchmark from [Evidence](#copy-cost), rerun on 2026-11-16 on the same machine against the final implementation, with the counters of [Call and event metrics](261116_035534-call-metrics.md) in place:

  | Payload | Provider schema | Sequential µs, before → after | Pipelined calls/s, before → after | Main-thread CPU µs per call, after |
  |---|---|---:|---:|---:|
  | `{ n: 1 }` | `v.unknown()` | 25.2 → 12.6 | 191,326 → 310,171 | 0 |
  | One order | `v.unknown()` | 46.6 → 24.9 | 60,720 → 107,585 | 0 |
  | One order | valibot object | 52.4 → 26.6 | 61,322 → 89,240 | 0 |
  | 64 orders | `v.unknown()` | 1,065 → 510 | 1,765 → 3,760 | 0 |
  | 64 orders | valibot array | 1,293 → 703 | 1,755 → 2,204 | 0 |
  | 1024 orders | `v.unknown()` | 18,882 → 9,373 | 107 → 209 | 0 |
  | `Uint8Array`, 1 MB | `v.unknown()` | 815 → 322 | 1,892 → 3,470 | 0 |
  | String, 1 MB | `v.unknown()` | 124 → 73 | 27,199 → 35,273 | 0 |

  With valibot schemas, pipelined throughput is now bound by validation in the provider's Worker rather than by copies.

## Confirmation

- The user accepted this decision on 2026-11-16 and chose to keep [Rack runtime architecture](261112_035942-rack-architecture.md) as it is, with the note under `## Impact`, instead of superseding it.
- Before the status changed to `accepted`, the Agent corrected one sentence of the switch: providers stop sending events to the old instance instead of closing its links, because closing them would keep the old instance from calling its needs while it finishes its calls, which [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) requires.
