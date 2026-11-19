# Faults and overload

## Crashes

When a device crashes (an uncaught exception, an unhandled rejection, or `process.exit`), its calls in flight fail with `RACK_DEVICE_FAULT` and the rack resets it from the same firmware. Calls during the reset fail with `RACK_LINK_DOWN`. In-memory state does not survive a reset, so keep state that matters in a storage device. After more than 3 crashes within 60 seconds, the slot is marked `faulted` until a swap succeeds. When a device's longest watchdog timeout is longer than 15 seconds, the window is four times that timeout instead, so a device that hangs after every reset reaches the limit too.

## Hangs and watchdogs

A device can hang without crashing: its event loop stays blocked, or one of its work loops stops making progress. Watchdogs catch both.

- **The event-loop watchdog.** Every device has one, which its Worker host feeds from a timer. If the device's event loop stays blocked for `watchdog` milliseconds, 10 000 by default, the watchdog bites.
- **Device watchdogs.** In `activate`, a device arms a watchdog for each work loop it wants watched, and feeds it from that loop:

  ```ts
  activate(ctx, scope) {
    const dog = scope.watchdog(5_000, "poller");
    void (async () => {
      while (!scope.signal.aborted) {
        await pollOnce(ctx);
        dog.feed();
      }
    })();
  },
  ```

  - `scope.watchdog(ms, name?)` bites when `feed()` isn't called for `ms` milliseconds, at least 1 000. `name` defaults to `watchdog 1`, `watchdog 2`, and so on.
  - `cancel()` disarms the watchdog, and `deactivate` disarms them all. A device can have 16 armed at once.
- **What a bite does.** A watchdog bites between 1 and 1.25 times its timeout after its last feed.
  - The device's calls in flight fail with `RACK_DEVICE_FAULT`, and the rack resets the device as after a crash, or falls back to its known-good firmware during probation. Bites count toward the crash limit.
  - The slot's error names the watchdog in its `data`: `{ watchdog: "poller", timeout: 5000 }`, or `{ watchdog: "event loop", timeout: 10000 }`.
- **Hangs in native code.** A device blocked inside native code, such as a long SQLite query or a blocking file read, stops only when that call returns. If its thread hasn't stopped within `hookTimeout` of the bite, the thread is stuck, and the slot is `faulted` until the thread stops and a swap or restart succeeds, as [Stuck threads](#stuck-threads) describes.
- **When watchdogs watch.** From the end of `activate` to the start of `deactivate`; `hookTimeout` bounds the hooks instead.
- **Turning them off.** `watchdog: 0`, or `--no-watchdog` for `rack start` and `rack dev`, turns off every watchdog, for example while a debugger holds devices at breakpoints. Raise `watchdog` instead for devices with long synchronous work, such as large SQLite queries.
- **Observing them.** `status()` lists each device's `watchdogs`, the event loop's first, with their `name`, `timeout`, and `lastFed`. `metrics()` reports each device's event-loop delay as `loop: { delayMs, maxDelayMs }`, the delay of the last tick of the event-loop watchdog's timer and the largest since the instance booted.

## Stuck threads

Wherever the rack stops an instance, in a swap, restart, rollback, unplug, reset, watchdog bite, or `stop()`, it ends it the same way: it terminates the instance's Worker and waits up to `hookTimeout` for the Worker's thread to stop.

- **Unanswered hooks.** While an instance stops, a hook that it doesn't answer within `hookTimeout` is its last. Its calls in flight fail with `RACK_DEVICE_FAULT`, and the rack ends it without waiting for its calls to drain or sending it `snapshot` or `powerOff`.
- **Stuck threads.** A thread blocked inside native code, such as a long SQLite query or a blocking file read, stops only when that call returns. One that hasn't stopped within `hookTimeout` of its termination is stuck. The rack logs it, emits a `fault` event, and lists it among the device's `stuck` threads in `status()`, with its `firmware` and `since`, when the rack terminated it. When the thread stops, the rack logs that too.
- **No second instance.** While a thread of a device is stuck, no other instance of the device starts:
  - `swap()`, `restart()`, `rollback()`, and `reload()` fail with `RACK_SWAP_REJECTED` for the device.
  - A cold swap or restart whose old thread gets stuck fails with `RACK_DEVICE_FAULT`, and the slot is `faulted`.
  - A reset, after a crash or a watchdog bite, leaves the slot `faulted` instead.
  - `unplug()` fails with `RACK_DEVICE_FAULT`, and the device stays in the rack, `faulted`.

  Once the thread stops, a swap or restart brings the device back, and `unplug()` removes it.
- **Firmware that gets stuck loading.** If a device file's top-level code gets stuck in native code while the rack loads it, the operation fails, and the rack doesn't load that firmware again until the thread stops.
- **Limits.** Only a restart of the rack reclaims a thread whose native call never returns. `stop()` waits for the threads of all devices together, so a stuck thread delays it by one `hookTimeout` at most.

## Overload

A device that falls behind can't take the rack down with it: every backlog between devices has a limit, and what goes beyond the limit fails at once.

- **Calls.** A need has at most `queueLimit` calls unfinished, 10 000 by default: calls on their way, being served, and held while the provider swaps.
  - Calls from outside the rack, through `call()`, are counted per device the same way. The HTTP panel's calls are calls of its needs, bounded as any.
  - A call beyond the limit fails at once with `RACK_OVERLOADED`, without reaching the provider. The HTTP panel answers it with 503.
- **Events.** A subscriber that falls `queueLimit` events behind misses the next ones. The provider counts them in `dropped`, and `emit` doesn't fail. Subscribers that keep up get every event.
- **Expired calls.** A provider doesn't start a call whose deadline passed while the call waited. It answers `RACK_TIMEOUT` at once, so a provider that falls behind spends its time on calls that someone still waits for.
- **Observing it.**
  - A refused call counts under `RACK_OVERLOADED` among the errors of its need in `metrics()`, and an expired call under `RACK_TIMEOUT` among the errors of the provider's member.
  - A refused call from outside the rack counts in the `outside` counters of `metrics()`, under its port and member.
  - `pending`, `active`, and the event-loop delay `loop` show load building up.
- **Policy stays in devices.** The rack doesn't retry, open circuit breakers, or limit rates on its own, since whether to retry, wait, or degrade depends on the device. A device can refuse work for a limit of its own, such as a pool of connections, by throwing `RACK_OVERLOADED`; callers and the HTTP panel treat it the same way.
