# Decision: Backplane protocol, error model, and fault handling

Status: superseded — replaced by [261116_024226-backplane-links.md](261116_024226-backplane-links.md)

## Background

- `sled` devices run in a Worker and the backplane runs on the main thread, so the two sides can communicate only through messages. The message format therefore needs to be fixed, along with the semantics of call routing, timeouts, errors, and events.
- Measurement shows that in Bun 1.3.13 an uncaught exception or an unhandled Promise rejection inside a Worker terminates the Worker outright (see [Evidence](#evidence)). The rack must be able to recognize and handle this kind of fault.

## Decision

### Channels

- Each Worker has two channels:
  - **Control channel**: the Worker's built-in `postMessage`, carrying power bus and management bus messages, including boot, lifecycle hooks, and logs.
  - **Data channel**: a separate `MessagePort` passed in at boot, carrying data bus messages, including RPC calls, call results, cancellations, events, and subscriptions.
- The control channel is request-response: each request carries an `id`, and the Worker replies with the same `id` using `{ ok: true, value }` or `{ ok: false, error }`.

### Boot and FRU

- After creating a Worker, the main thread sends a `boot` message that contains: the firmware file URL, slot information, configuration, base directory, and the data channel port.
- On receipt, the Worker performs the following in order:
  1. Loads the firmware and confirms that the default export is a device definition.
  2. Validates the configuration.
  3. Replies with FRU information: model, height, `needs` and `provides` (the connector `id`, member names, and member types of each port), and whether it implements `snapshot`/`restore`.
- Up to this point only the top-level code of the device module has run, and `powerOn` has not been called.

### Wiring and routing

- Wiring is a slot-level mapping: `(consumer device, need) → (provider device, port)`. Wiring is determined when a device is plugged in and stays unchanged across a swap.
- Wiring follows these rules:
  - When `patch` specifies it, connect according to `patch`.
  - Without `patch`, look for a port with the same connector `id` among devices in lower slots; when exactly one is found, connect automatically, and when none or several are found, the assembly fails.
  - The provider must be below the consumer (gravity rule).
- Every call resolves the route again: the backplane always forwards the call to the instance currently installed in the provider slot.
- Callers outside the rack (`rack.call` and the panel) address `<device>.<port>` directly and do not go through the wiring table.
- During a swap, ports referenced by panel routes are treated the same as wired ports: they must not disappear, and they must not change their connector.

### RPC

- The caller sends a `call` message that contains: the call ID, `need`, member name, input, and timeout duration.
- The backplane converts it into a `call` message for the provider instance that contains: a new call ID, port, member name, input, deadline (`Date.now() + timeout`), and caller address.
- The default timeout is 30 seconds. The backplane decides the timeout: it returns `RACK_TIMEOUT` to the caller and sends `cancel` to the provider at the same time.
- When the caller cancels on its own initiative, the caller rejects the call locally with `RACK_CANCELLED` immediately, and the backplane forwards `cancel` to the provider.
- When the provider receives `cancel` or reaches the deadline, it aborts the `call.signal` passed to the implementation function.

### Where validation happens

- The backplane does not do schema validation; it only routes.
- Validation happens at the following places:
  - The provider validates RPC input and output in its own Worker.
  - The publisher validates event payloads.
  - The Worker validates the configuration at boot.
- Invalid input returns `RACK_INVALID_INPUT`, and invalid output returns `RACK_INVALID_OUTPUT`.

### Events

- After a publisher sends `emit`, the backplane delivers the event to consumers that are wired to that port and whose currently installed instance has subscribed to the event.
- Only events emitted by the installed instance are delivered; events emitted by a standby instance are dropped and a warning is logged.
- Delivery is at most once. Between the same pair of provider and consumer, events arrive in emission order.

### In-flight calls, pausing, and draining

- The backplane records the number of calls each instance is processing.
- During a state handover, the slot is paused:
  - Calls and events addressed to it are queued and handed to the new instance in order after the switch completes.
  - The queue holds at most 10000 entries. Beyond that limit, new calls fail with `RACK_LINK_DOWN` and new events are dropped.
- Draining: wait until the number of calls the instance is processing drops to zero, for at most `drainTimeout` (default 10 seconds). After the timeout, the remaining calls fail with `RACK_LINK_DOWN` and the instance is forcibly powered off.

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

- When a Worker exits, as long as the rack did not terminate it deliberately, the instance is always judged to have crashed, whatever the exit code is. The reason is that an exit caused by an unhandled Promise rejection also has exit code 0, the same as a normal termination. The rack does the following:
  - Calls the instance is processing fail with `RACK_DEVICE_FAULT`.
  - The device resets automatically from the same firmware: a new instance is created, and `powerOn`, `selfTest`, and `activate` run in order. A reset does not keep in-memory state.
  - When the device crashes more than 3 times within 60 seconds, resets stop and the slot is marked as faulted. Calls sent to it afterward return `RACK_LINK_DOWN` until a swap succeeds.
- The following errors are only logged and do not crash the device: errors thrown by timers managed by the rack (`scope.every`/`scope.after`), and errors thrown by event handlers.

## Evidence

Measured on 2026-11-12 on Bun 1.3.13 on this machine:

- After an uncaught exception is thrown in a Worker timer, the Worker fires `error` and `close` (code 1), and a later call to `postMessage` throws "Worker has been terminated".
- An unhandled Promise rejection likewise fires `error` and `close` (code 0) and terminates the Worker.
- Calling `preventDefault()` in the `error` event cannot prevent the Worker from being terminated.
- After the main thread calls `terminate()`, the Worker fires `close` with code 0. After `process.exit(3)` is called inside the Worker, it fires `close` with code 3.
- After structured clone, `Error` is still an `Error` instance and keeps `message`, but custom properties such as `code` and `data` are lost.
- Functions cannot be cloned and throw `DataCloneError`. A cloned class instance loses its prototype.
- A `MessagePort` can be passed to a Worker through the transfer list of `postMessage`.

## Alternatives

- **Send every message over the same channel**: with heavy traffic, lifecycle and management messages would queue behind business messages.
- **Validate centrally in the backplane (main thread)**: the validation cost of every device would concentrate on the main thread, and the backplane would no longer be "passive".
- **Have the caller validate output**: every consumer would repeat the validation; validating once in the provider is enough to catch a provider's error.
- **Do not reset automatically after a crash**: a single unhandled rejection would take the device offline permanently until someone swaps it manually.
- **Catch uncaught exceptions inside the Worker and keep the Worker running**: the device may already be in an inconsistent state; resetting from a clean state after a crash gives more predictable results.
- **Deliver events at least once**: this requires persistence and an acknowledgment mechanism, which is beyond the scope of P0.

## Impact

- Every call is forwarded one extra time through the main thread; P0 does not optimize for batching or zero copy.
- A reset loses in-memory state, so a device that needs to keep state should put it in a storage device.
- Fault resets handle crashes only. Detecting a hung device (one that has not crashed but no longer responds) is left to a watchdog in a later stage.

## Implementation

- Error model: `RackError`, `WireError`, `toWireError`, `fromWireError`, `isRackError`, and `isCloneable` in `src/errors.ts`, tested in `test/errors.test.ts`.
- Channels and messages: the message types in `src/protocol.ts`; the Worker side in `src/worker.ts`; the main-thread side in `Instance`, `src/instance.ts`.
- Boot and FRU: `boot` in `src/worker.ts` and `Instance.boot` in `src/instance.ts`.
- Wiring, routing, RPC, events, pausing, and draining: `Backplane` in `src/backplane.ts`, with wiring resolved in `src/rack.ts`; tested in `test/backplane.test.ts`, `test/rack.test.ts`, and `test/swap.test.ts`.
- Faults and resets: `src/rack.ts`, tested in `test/reset.test.ts`.
- The data channel needs Bun 1.4.4 or later; see [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#evidence).

## Confirmation

- Drafted by the Agent and revised on 2026-11-12 based on measurement results: the wire format of errors, the error codes for when cloning fails, and the rule that judges a crash by "whether the rack terminated it deliberately" were added.
- The user authorized the Agent to decide general decisions on its own. The user reported that Fable had no quota and would no longer be used, so difficult decisions were also left to the Agent. This decision is therefore set to `accepted`.
