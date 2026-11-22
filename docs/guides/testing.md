# Testing a device

## The bench

`racku/bench` runs one device in a rack of its own, with a stub for each of its needs that the test implements, and records what the device does. Tests go apart from the device files, such as in `test/`, since a [scanned rack](racks.md#scanned-racks) takes every file of its directories for a device. For the greeter of [Devices](devices.md):

```ts
// test/greeter.test.ts
import { expect, test } from "bun:test";
import { bench, stub } from "racku/bench";
import { Kv } from "racku/std";

test("greeter greets and remembers the last name", async () => {
  const store = new Map<string, string>();
  await using greeter = await bench(new URL("../devices/greeter.ts", import.meta.url), {
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
| `needs` | One `stub()` per need, by need name, `own` and `patched()` needs included. For an [every need](hotplug.md#every-needs), an object of stubs by the names of the devices that it reaches, such as `{ tools: { upper: stub(Tool, { … }) } }`. |
| `config`, `name` | As `slot()` takes them. |
| Others | Those of `start()`, such as `baseDir`, `callTimeout`, and `watchdog`; the bench records the log itself. |

A need without a stub, a stub of another connector, and a stub for a need the device doesn't have fail with `RACK_MANIFEST`. Otherwise `bench()` fails as `start()` does.

A test that gives the bench a base directory of its own, such as for the files that the device writes, makes it inside the app, such as in a folder that git ignores: firmware imports racku and the app's packages from the base directory, and a base directory outside the app fails with `RACK_MANIFEST`, whose message says so.

When it stops, the bench deletes its own files, under `.rack/bench/`, and leaves the rest of the base directory, such as the firmware in `.rack/`, for the next run. A test that wants a fresh directory removes it once the bench has stopped, and the next bench in it makes `.rack/` again.

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
| `call(port, member, input, options?)` | Call a port of the device, as `rack.call()` calls `<device>.<port>`. It resolves with the result, or rejects with the `RackError` of the failed call, so `await expect(bench.call(…)).rejects.toMatchObject({ code })` checks a failure. |
| `events` | The events the device emitted, as `{ port, event, payload, at }`. They come through the probe's Worker, so one can arrive just after the call that emitted it returns. |
| `logs` | The rack's log entries, the device's included. |
| `faults` | The device's crashes and watchdog bites, as `{ firmware, error, reset, at }`. |
| `swap(source?)`, `restart()`, `reload()` | Replace the device, as the rack handle's methods do; see [Swaps](#swaps). |
| `injectFault(kind)` | Make the device crash or hang on purpose, as [Crashes and hangs](#crashes-and-hangs) describes. |
| `rack` | The rack handle, for `status()`, `metrics()`, `history()`, and the rest. |
| `stop()` | Stop the rack and delete the bench's files; `await using` calls it at the end of the scope. |

- The device emits as in any rack: an event emitted before the device is installed is dropped, such as one from `powerOn` during a swap, and so is one beyond `queueLimit`, which is counted.
- `calls`, `events`, `logs`, and `faults` keep the last 10 000 records each; `stub.dropped` and `bench.dropped.events`, `.logs`, and `.faults` count the older ones.
- The bench writes its stub and probe device files into a directory under `.rack/bench/` in the base directory, and deletes it when it stops. `status()` lists them as `stub-<need>` and `probe`.
- A device's [listeners](listeners.md) work as in any rack, and `status()` shows their URLs.
- One device per bench. A test of several real devices together starts a rack.

## Swaps

A swap hands the device's in-memory state from its old instance to its new one, through `snapshot` and `restore`, so a test swaps the device and checks what it kept, and what changed:

```ts
// test/greeter-swap.test.ts
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { bench, stub } from "racku/bench";
import { Kv } from "racku/std";

test("greeter greets on across swaps", async () => {
  await using greeter = await bench(new URL("../devices/greeter.ts", import.meta.url), {
    config: { prefix: "Hello," },
    needs: { cache: stub(Kv, { set: () => {} }) },
  });

  // The same file: a new instance, whose restore gets the old one's snapshot.
  await greeter.swap();
  const [swapped] = greeter.rack.history();
  expect(swapped).toMatchObject({ mode: "hot", cause: "swap", ok: true });
  expect(swapped?.to).toBe(swapped?.from ?? ""); // the same firmware

  // A changed copy, next to the device, so that its imports resolve.
  const next = new URL("../devices/greeter-next.ts", import.meta.url);
  const source = await Bun.file(new URL("../devices/greeter.ts", import.meta.url)).text();
  await Bun.write(next, source.replace("${name}`", "${name}!`"));
  try {
    await greeter.swap(next);
    expect(await greeter.call("greeter", "greet", { name: "Ada" })).toBe("Hello, Ada!");
  } finally {
    await rm(next);
  }
});
```

- **The same file.** `swap()` replaces the device even when its file hasn't changed, so a test of the handover needs no other file. In a rack, the handle's `swap(name)` does the same.
- **A changed device.** `swap(source)` takes another device file, such as a changed copy of the device, written next to it so that its relative imports resolve; a path is relative to the base directory. A scanned rack refuses another file with `RACK_SWAP_REJECTED`; there, a test changes the device's own file, and swaps it.
- **What happened.** `history()` lists the swap's record first. Its `mode` and `cause` say how and why, and its `from` and `to` are the old and the new firmware hash, the same when the file didn't change, as [History](updates.md#history) describes.

## Crashes and hangs

A device crashes when its own code lets an exception or a rejection go uncaught, or calls `process.exit()`, and it hangs when its event loop stays blocked, as [Faults and overload](faults.md) describes; the bench records either in `faults`. A test makes the device do either on purpose with `injectFault()`, with no test code in the device:

```ts
await orders.injectFault("crash"); // an uncaught exception in its Worker: the rack resets it
await orders.injectFault("hang"); // a blocked event loop, until the event-loop watchdog bites
```

- **The paths of real faults.** The rack handles an injected fault as any other: calls in flight fail with `RACK_DEVICE_FAULT`, the device starts again without its state, the faults count toward the crash limit, and during probation the device falls back to its known-good firmware. A crash's error says `injected crash`, and the log says `<device>: injecting a <kind>` first.
- **When it resolves.** Once the device's Worker has taken the fault, before the crash or the bite. A hang lasts until the event-loop watchdog bites, after `watchdog` milliseconds: give the bench a short one, such as `watchdog: 1_000`.
- **A whole app.** The bench always allows it. A rack started with `start()` allows `rack.injectFault(name, kind)` only with `faultInjection: true`, so that a rack in production refuses it with `RACK_SWAP_REJECTED`; so does a rack whose watchdogs are off, for a hang.

A test also reaches what follows a fault in two other ways:
- **Starting again without state.** `restart()` starts the device again from scratch, without its in-memory state, as the reset after a crash does. So it tests how the device gets its state back, such as from a storage device.
- **A need that fails.** A stub throws what a crashed provider gives its callers, such as `new RackError("RACK_LINK_DOWN", …)` while the provider resets, or never settles, as a provider that hangs never answers, so that the device's call times out.
