# Decision: A test bench for one device

Status: accepted

## Background

- [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope) put the single-device test bench off for later.
- On 2026-11-18 the user listed "the ability to test a single device on its own" among the gaps P3 closes, and left its design to the Agent: "do whatever you think is the best implementation".
- Today a builder tests a device by starting a whole rack around it:
  - Every device it needs must exist as a device file, with the state the test wants, and the test can't see the calls the device makes to them.
  - The device's events reach only devices above it, so a test sees them only through another device file written for the purpose.
  - The repository's own tests work this way, with fixture devices in `test/fixtures/devices/`.
- What a bench must keep from a rack, so that a test passes or fails as the device would in a rack:
  - the firmware build, the device's Worker, the validation of its configuration, and its lifecycle hooks;
  - structured clones at every boundary, schemas validated at the provider, timeouts, and cancellation;
  - swaps, with `snapshot` and `restore`, restarts, and resets after crashes and watchdog bites.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since builders can test the failure paths of a device, such as a need that fails, hangs, or goes offline, and a swap in the middle of its work;
  - maintainability, since a device can be tested on its own, with test doubles for what it needs, in one test file;
  - observability, since a test sees every call the device makes to a need, every event it emits, and its log;
  - extensibility, since a builder tests a device before it joins a rack.

### Evidence

Measured on 2026-11-18 on the local machine, Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores, with Bun 1.4.4 and probe scripts outside the repository:

- A `BroadcastChannel` with a random name carried messages between the main thread and a Worker in both directions, including a `Uint8Array`. 10,000 round trips took 44 ms.
- The firmware build keeps imports of `rack42u` external, including its subpaths, as the standard devices' imports of `rack42u/std` show. A device file that imports `rack42u/bench` keeps it external the same way.
- A hand-placed manifest already patches a need to a chosen port, and the rack handle already calls ports from outside, swaps, restarts, reloads, and reports logs, faults, status, and metrics.

## Decision

### The bench

- A new entry point, `rack42u/bench`, exports `bench()` and `stub()`:

  ```ts
  import { expect, test } from "bun:test";
  import { bench, stub } from "rack42u/bench";
  import { Kv } from "rack42u/std";

  test("orders keeps an order across a swap", async () => {
    const store = new Map<string, unknown>();
    await using orders = await bench(new URL("../devices/orders.ts", import.meta.url), {
      config: { currency: "EUR" },
      needs: {
        kv: stub(Kv, {
          get: ({ key }) => store.get(key) ?? null,
          set: ({ key, value }) => {
            store.set(key, value);
          },
        }),
      },
    });
    const order = await orders.call("orders", "create", { item: "tea", quantity: 2 });
    expect(orders.needs.kv.calls).toContainEqual(
      expect.objectContaining({ member: "set", input: expect.objectContaining({ key: `order:${order.id}` }) }),
    );
    expect(orders.events).toContainEqual(expect.objectContaining({ port: "orders", event: "created" }));
    await orders.swap(); // a hot swap, with snapshot and restore
    expect(await orders.call("orders", "count", undefined)).toBe(1);
  });
  ```

- `bench(source, options)` builds the device file into firmware and runs it in a rack of its own, with a stand-in for each of its needs below it, as the rack would place it:
  - `source` is the device file, a path relative to `baseDir` or a `file:` URL.
  - `options.needs` has one `stub()` per need of the device, by need name, own and patched needs included. A need without one fails the bench with `RACK_MANIFEST`, naming the need.
  - `options.config` and `options.name` are those of `slot()`. The other options are those of `start()`, such as `callTimeout`, `watchdog`, and `baseDir`, with `logger` replaced by the bench's own record.
  - It resolves once the device is online, and fails as `start()` does, with `RACK_INVALID_CONFIG`, `RACK_HOOK_FAILED`, or `RACK_MANIFEST`.
- The bench is a test tool. The device under test runs as in any rack, so the rack's main thread still never imports device code: the bench builds the device's file and runs it in a Worker.

### Stubs

- `stub(connector, implementation)` stands in for one need. `implementation` has the RPC members of the connector, as a device's port has, and the bench validates their input and output with the connector's schemas, as the rack validates at a provider.
  - An implementation that throws a `RackError` gives the device that error, so a test can answer `RACK_LINK_DOWN`, `RACK_OVERLOADED`, or any code of its own. A test that wants a need that hangs returns a promise that doesn't settle, and the device's call times out.
  - A need whose connector id differs from the stub's fails the bench with `RACK_MANIFEST`, as a patch to a port of another connector does.
- Each stub records the calls it received, as `{ member, input, at }`, in `stub.calls`, and emits the connector's events to the device with `stub.emit.<event>(payload)`, typed by the connector.
- How a stub runs:
  - The bench describes the device first, as `rack plan` does, and writes for each need a stub device file of two lines into `.rack/bench/` under the base directory. It provides the need's connector, by its id and members, and imports its code from `rack42u/bench`.
  - The stub device runs in a Worker of its own, below the device under test, and the manifest patches the need to it. So the device reaches it over an ordinary link: its calls are held during swaps and time out as any call does.
  - The stub device passes each call to the test's thread over a `BroadcastChannel` with a random name, and returns the answer. A cancelled call cancels at the test's thread, where the implementation's `call.signal` aborts.
  - The stub device's own schemas accept anything, so that the connector's schemas in the test's thread decide, where the implementation runs.
- Calls to a stub copy their input and output, without transfers, and a stream in a stub's call is read whole before it crosses, up to 16 MiB, and passed on as a stream. Beyond that, the call fails with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.

### What a test sees and does

- `bench.call(port, member, input, options?)` calls a port of the device, as `rack.call()` calls `<device>.<port>`.
- `bench.events` records the events the device emits, as `{ port, event, payload, at }`. A probe device above the device under test, which the bench writes as it writes the stubs, consumes each of its ports and passes the events to the test's thread over the same channel. So the device emits as it does in a rack: an event emitted before the device is installed is dropped, and one beyond `queueLimit` is dropped and counted.
- `bench.logs` records the log entries of the rack, the device's included, and `bench.faults` the faults of the device.
- `bench.swap(source?)`, `bench.restart()`, and `bench.reload()` replace the device as the rack handle's methods do. `bench.rack` is the rack handle itself, for `status()`, `metrics()`, `history()`, and the rest.
- `bench.stop()` stops the rack, closes the channel, and deletes the bench's files. `await using` stops it at the end of the scope, through `Symbol.asyncDispose`.
- A device's listeners work as in any rack, and `status()` shows their URLs.

### Failure modes

| Failure | Outcome |
|---|---|
| A need without a stub, or with a stub of another connector | `bench()` fails with `RACK_MANIFEST` |
| A bad configuration, or a failed hook | `bench()` fails as `start()` does |
| The device sends a stub input its schema rejects | the call fails with `RACK_INVALID_INPUT`, and the stub records it |
| A stub's implementation throws | the device's call fails with the error's code, or `RACK_DEVICE_FAULT` for an error without one |
| A stub's implementation returns output its schema rejects | the call fails with `RACK_INVALID_OUTPUT` |
| A stub's implementation doesn't settle | the device's call times out with `RACK_TIMEOUT`, and the implementation's `call.signal` aborts |
| A stream in a stub's call over 16 MiB | the call fails with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT` |
| The device crashes or hangs | the rack resets it, as in any rack, and `bench.faults` records it |

### Bounds

| What | Bound |
|---|---|
| Records of calls per stub, of events, of log entries, and of faults | the last 10 000 each; older ones are dropped, and `stub.dropped` and `bench.dropped.events`, `.logs`, and `.faults` count them |
| A stream in a stub's call | 16 MiB |
| A stub's call | the device's call timeout, as for any call |
| The bench's files | one directory under `.rack/bench/`, deleted at `stop()` |

### Observation

- The records are the observation: `stub.calls`, `bench.events`, `bench.logs`, and `bench.faults`, with the counts of what they dropped.
- `bench.rack` gives the rack's own: `status()`, `metrics()` with the device's counters, and `history()`.

### Tests

- A device with two needs runs against two stubs; its calls reach them, validated; the stubs' records hold them; a stub's event reaches the device.
- A missing stub, and a stub of another connector, fail with `RACK_MANIFEST`.
- A stub that throws `RACK_LINK_DOWN`, one that returns bad output, and one that never answers, as the device sees them.
- The device's events, including one emitted before it was installed, which is dropped.
- A hot swap that carries state through `snapshot` and `restore`, a restart without it, and a crash that resets the device.
- A device that serves HTTP with `ctx.serve`, reached at the URL `status()` shows.
- Streams through a stub, within and over 16 MiB.
- `await using`, which stops the rack and deletes the bench's files.
- The tests run on Linux, macOS, and Windows.

### Scope

- One device per bench, with stubs for its needs. A test that needs several real devices together starts a rack, as today.
- The bench changes nothing in the rack, the backplane, or the Worker host.

## Alternatives

- **Stubs that run in the test's thread and speak the link protocol**: no Worker per stub, and calls could transfer buffers and stream at full speed. But the provider's and the consumer's ends of a link live in the Worker host today, and serving them from the main thread means taking them out of it and giving the backplane providers without a Worker. That is a large change to the core for a test tool.
- **Load the device's module in the test's thread with a hand-made `ctx`**: the fastest, and no files to write. But it skips the firmware build, the Worker, the clones, the schemas at the boundary, and the swaps, so a test could pass where the rack would fail. A module loaded once can't be swapped either.
- **Stubs as device files that the builder writes**: no stub runtime. But each test double is a file of its own, its state lives in another Worker, and the test can't see the calls it gets without more code.
- **A `MessagePort` per stub instead of a `BroadcastChannel`**: a port can be transferred, but a device's configuration is cloned without a transfer list, so no port can reach a stub device that way.

## Impact

- New: `src/bench.ts`, `rack42u/bench` in `package.json`'s `exports`, and a README section "Testing a device".
- `AGENTS.md`: the repository structure lists `src/bench.ts`, and the current state lists the bench.
- No change to the rack, the backplane, the Worker host, or any existing API.
- Follow-up work once this decision is accepted:
  - `src/bench.ts`, with `bench()`, `stub()`, and the code that the stub devices and the probe device import.
  - A test file, `test/bench.test.ts`, for the tests above, with a fixture device that needs two connectors.
  - The README section, with the example above.

## Confirmation

- The user accepted this decision on 2026-11-18, after reviewing it: "I've reviewed it and I agree. Commit it."
- The user had left the design of the bench to the Agent: "do whatever you think is the best implementation".
