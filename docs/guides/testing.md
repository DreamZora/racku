# Testing a device

## The bench

`rack42u/bench` runs one device in a rack of its own, with a stub for each of its needs that the test implements, and records what the device does. For the greeter of [Devices](devices.md):

```ts
// devices/greeter.test.ts
import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Kv } from "rack42u/std";

test("greeter greets and remembers the last name", async () => {
  const store = new Map<string, string>();
  await using greeter = await bench(new URL("./greeter.ts", import.meta.url), {
    config: { prefix: "Hello," },
    needs: {
      cache: stub(Kv, {
        get: (key) => store.get(key) ?? null,
        set: ({ key, value }) => {
          store.set(key, value);
        },
      }),
    },
  });
  expect(await greeter.call("greeter", "greet", { name: "Ada" })).toBe("Hello, Ada");
  expect(store.get("last")).toBe("Ada");
  expect(greeter.needs.cache.calls).toContainEqual(expect.objectContaining({ member: "set" }));
  await greeter.swap(); // a hot swap, with snapshot and restore
  expect(await greeter.call("greeter", "greet", { name: "Grace" })).toBe("Hello, Grace");
});
```

`bench(source, options)` builds the device file into firmware and runs it as any rack would: in its own Worker, with its configuration validated, its hooks, copies at every boundary, timeouts, cancellation, swaps, and resets. Below it, a stub device stands in for each need, and above it a probe records the events it emits. It resolves once the device is online.

| Option | Meaning |
|---|---|
| `needs` | One `stub()` per need, by need name, `own` and `patched()` needs included. |
| `config`, `name` | As `slot()` takes them. |
| Others | Those of `start()`, such as `baseDir`, `callTimeout`, and `watchdog`; the bench records the log itself. |

A need without a stub, a stub of another connector, and a stub for a need the device doesn't have fail with `RACK_MANIFEST`. Otherwise `bench()` fails as `start()` does.

## Stubs

`stub(connector, implementation)` takes functions for some or all of the connector's RPC members, with the arguments a port's functions get.
- The connector's schemas validate each call's input and output in the test, as the rack validates them at a provider: invalid input fails the device's call with `RACK_INVALID_INPUT`, and invalid output with `RACK_INVALID_OUTPUT`.
- An implementation that throws a `RackError` gives the device that error's code; any other error, or a call to a member without an implementation, reaches it as `RACK_DEVICE_FAULT`. One that never settles lets the device's call time out, and its `call.signal` aborts.
- `stub.calls` records each call the stub got, invalid ones included, as `{ member, input, at }`.
- `stub.emit.<event>(payload)` emits one of the connector's events to the device. The schema validates the payload, which fails with `RACK_INVALID_OUTPUT`, and the promise resolves once the stub has emitted it.
- Calls to a stub copy their data, and `call.transfer()` does nothing. A stream in a call's input or result crosses read whole, up to 16 MiB, and `calls` records it as its bytes, a `Uint8Array`. A larger one fails the call with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
- So a limit of a device above 16 MiB, such as the largest upload it takes, can't be reached through a stub. Such a device takes the limit from its configuration, so that a test on the bench sets a small one, and a test of the real limit starts a rack with the devices that the device needs, whose streams flow as [Streams](data.md#streams) describes.
- A stub serves one running bench at a time.

## Members of a bench

| Member | Purpose |
|---|---|
| `call(port, member, input, options?)` | Call a port of the device, as `rack.call()` calls `<device>.<port>`. |
| `events` | The events the device emitted, as `{ port, event, payload, at }`. They come through the probe's Worker, so one can arrive just after the call that emitted it returns. |
| `logs` | The rack's log entries, the device's included. |
| `faults` | The device's crashes and watchdog bites, as `{ firmware, error, reset, at }`. |
| `swap(source?)`, `restart()`, `reload()` | Replace the device, as the rack handle's methods do. |
| `rack` | The rack handle, for `status()`, `metrics()`, `history()`, and the rest. |
| `stop()` | Stop the rack and delete the bench's files; `await using` calls it at the end of the scope. |

- The device emits as in any rack: an event emitted before the device is installed is dropped, such as one from `powerOn` during a swap, and so is one beyond `queueLimit`, which is counted.
- `calls`, `events`, `logs`, and `faults` keep the last 10 000 records each; `stub.dropped` and `bench.dropped.events`, `.logs`, and `.faults` count the older ones.
- The bench writes its stub and probe device files into a directory under `.rack/bench/` in the base directory, and deletes it when it stops. `status()` lists them as `stub-<need>` and `probe`.
- A device's [listeners](listeners.md) work as in any rack, and `status()` shows their URLs.
- One device per bench. A test of several real devices together starts a rack.
