# Decision: Ending instances and stuck threads

Status: accepted

## Background

- The rack ends an instance by terminating its Worker. Bun ends a Worker that hangs in JavaScript within milliseconds, but one blocked in native code, such as a long SQLite query or a read from a pipe, only when that call returns, as [Watchdog](261117_062959-watchdog.md#evidence) measured.
- Only a watchdog bite waits for the thread to end. If it hasn't ended within `hookTimeout`, the slot becomes `faulted`, so that two instances of the device never run at once. Every other path terminates the Worker and goes on at once: cold swaps, restarts, group replacements, rollbacks, hot swaps, unplugs, failed starts, resets, and `stop()`.
- Measured on 2026-11-17 with Bun 1.4.4 and a probe script outside the repository, with `hookTimeout` at 1 s and `drainTimeout` at 0.5 s, and a 1 s watchdog in the hot swaps:

  | Case | What happened |
  |---|---|
  | `restart()` of a `swap: "cold"` device blocked opening a FIFO | `restart()` succeeded after 2.8 s. The new instance served calls while the old thread was still blocked. |
  | Hot swap of a device blocked opening a FIFO | The swap failed: `deactivate` timed out. The old instance stayed installed, `degraded`, and no watchdog bit within 4 s. Once the FIFO opened, the old thread ran the late `deactivate`: the device's background work stopped while the rack kept routing calls to it. |
  | Hot swap of a device hung in `while (true) {}` | The same failure. No watchdog bit within 16 s, and every call timed out. |

- So:
  - A cold device can run twice. The old thread may still hold the file lock or serial port that `swap: "cold"` exists for.
  - Nothing shows the leftover thread: the log says the instance powered off, and `status()` says `online`.
  - Each swap or restart of a device that stays stuck leaves one more thread, with its memory and, for a busy native call, a CPU core.
  - A swap or restart of a slot that a bite left `faulted` doesn't check whether the stuck thread has ended.
  - Watching stops when `deactivate` starts. A hot swap whose `deactivate` fails keeps the old instance without activating it again, so no watchdog watches it any more. [Hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) has the old instance run `activate` again after a failed step, but doesn't say what happens when it can't.
  - A hung instance still gets every remaining hook. A cold swap waits `hookTimeout` for `deactivate`, `drainTimeout` for the calls, and `hookTimeout` each for `snapshot` and `powerOff`: up to 100 s with the defaults, while its calls are held.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since a hung device is contained and every stop has a bound and a defined outcome; and observability, since a stuck thread shows in `status()`.

## Decision

### Ending an instance

- The rack ends every instance the same way: it terminates the Worker, then waits for the Worker's thread to end, up to `hookTimeout`. Swaps, restarts, group replacements, rollbacks, fallbacks, unplugs, failed starts, resets, watchdog bites, and `stop()` all do so.
- While the rack stops an instance, a hook that the instance doesn't answer within `hookTimeout` is its last. The rack fails the instance's calls in flight with `RACK_DEVICE_FAULT` and ends it, without waiting for its calls to drain or sending it further hooks.
- `stop()` ends the instances from the top down as now, but waits for their threads together, so a stuck thread delays it by one `hookTimeout` at most.

### Stuck threads

- A thread that hasn't ended within `hookTimeout` of its termination is stuck. The rack:
  - logs it as an error, and emits a `fault` event;
  - lists it in the device's `status()` until it ends;
  - logs when it ends.
- While a thread of a device is stuck, the rack starts no other instance of that device:
  - A swap, restart, rollback, or reload that would start one fails at once with `RACK_SWAP_REJECTED`, naming the stuck thread.
  - A reset or fallback that would start one leaves the slot `faulted`.
- A cold swap, restart, or group replacement starts its new instances only after the old instances' threads have ended. If one is stuck, the replacement fails with `RACK_DEVICE_FAULT`: that device's slot becomes `faulted`, and the rest of the group starts its old firmware again, as when a start fails.
- `unplug()` removes a device only after its thread has ended. If the thread is stuck, `unplug()` fails with `RACK_DEVICE_FAULT`, and the slot stays in the rack, `faulted`, until an `unplug()` succeeds.
- A device therefore has at most two threads at any time: the two instances of a hot swap, or a stuck thread and the instance that ran beside it.

### Failed hot swaps

- When a hot swap fails, the old instance runs `activate` again, as [Hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) decides, even when its `deactivate` threw an error. Its watchdogs watch it again from there.
- An old instance that didn't answer `deactivate` within `hookTimeout`, or doesn't activate again, can't keep serving. The rack ends it, and the slot recovers as after a watchdog bite: a reset from the same firmware, or a fallback while on probation, counted toward the crash limit.
- The new instance is ended once the old one serves again or is ended, so a stuck new instance doesn't delay the old one.

### Inspecting firmware

- A Worker that loads firmware only to read what it declares is ended the same way. If its thread is stuck, the operation that inspected the firmware fails, and the rack doesn't inspect that firmware again until the thread ends.

### Observation

- `SlotStatus` gains one field:

  ```ts
  interface SlotStatus {
    // ...the fields it has
    /** Threads of earlier instances that didn't end within hookTimeout of their termination. */
    stuck: { firmware: string; since: number }[]; // since: when the rack terminated it
  }
  ```

- The slot's `error` names the stuck thread while the slot is `faulted` because of it.

### Tests

The tests block a device in native code with a FIFO, as the watchdog tests do, and hang it in JavaScript with a loop:

- A cold restart whose old thread ends within the wait succeeds, and the new instance's `powerOn` runs only after the old thread ended.
- A cold restart whose old thread stays stuck fails with `RACK_DEVICE_FAULT`, the slot is `faulted` with the thread in `stuck`, and the device's `powerOn` never runs. A second restart fails with `RACK_SWAP_REJECTED` until the FIFO opens, then succeeds.
- A hot swap of a device hung in JavaScript fails, and the slot resets and serves again. One hung in native code leaves the slot `faulted` while the thread is stuck.
- A hot swap whose `deactivate` throws keeps the old instance serving, and its watchdog bites when it hangs afterwards.
- A hot swap whose new instance gets stuck in `powerOn` keeps the old instance serving, and the next swap fails with `RACK_SWAP_REJECTED` until the thread ends.
- An unplug of a stuck device, a restart of a slot that a bite left `faulted`, and `stop()` with a stuck thread behave as above.
- A cold restart of a device hung in JavaScript takes about one `hookTimeout`, not four.

## Alternatives

- **Wait for the thread without a bound**: never two instances, without a new state. But a thread that never returns would hold the operation, and the slot's calls, forever.
- **Start the new instance anyway, and only report the stuck thread**: service comes back sooner. But a cold device would run twice, which is what `swap: "cold"` exists to prevent, and stuck threads would pile up without bound.
- **Let hot devices start beside a stuck thread, and make only cold devices wait**: more availability in a rare case. But it takes two rules instead of one, and a hot device that hangs at every swap would leak a thread per swap.
- **Reset the slot by itself once its stuck thread ends**: service would come back without an operator. But [Watchdog](261117_062959-watchdog.md#biting) keeps such a slot `faulted` until a swap or a restart succeeds, and changing that needs a decision of its own.
- **Finish a hot swap with the new instance when the old one hangs**: the update the operator asked for would land, without the old state. But [Hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) keeps the old firmware when a swap fails, and the operator can swap again once the slot has reset.
- **Keep sending the remaining hooks to an instance that timed out**: a slow instance gets every chance. But each hook costs a hung instance a full `hookTimeout`, while its calls are held.
- **Run devices that block in native code in a child process, the `chassis` form**: a process can be killed even inside native code. That form needs a decision of its own; this one bounds what a Worker can do meanwhile.

## Impact

- A cold device never runs twice, and stopping a hung instance takes a known time: `hookTimeout` for the hook it didn't answer, and `hookTimeout` for its thread to end.
- A device stuck in native code can't be swapped, restarted, or unplugged until its thread ends or the rack restarts. Only a restart of the rack reclaims a thread whose native call never returns, as before.
- `swap()`, `restart()`, `rollback()`, `reload()`, and `unplug()` can fail in new ways: `RACK_SWAP_REJECTED` while a thread is stuck, and `RACK_DEVICE_FAULT` when an old thread doesn't end.
- Calls in flight to an instance that stops answering its hooks fail with `RACK_DEVICE_FAULT` at once, instead of with `RACK_LINK_DOWN` after `drainTimeout`.
- `SlotStatus` gains `stuck`.
- `rack stop` can take up to one `hookTimeout` longer when a thread is stuck. A second signal still exits at once.
- A device file whose top-level code blocks in native code leaves a stuck thread for each version of it that the rack inspects, such as each edit under `rack dev`. The edits bound those threads, not a fixed limit.
- Follow-up work once this decision is accepted:
  - One way to end instances in `src/instance.ts` and `src/rack.ts`, and the record of stuck threads.
  - The failed hot swap path, and the hooks skipped after a timeout.
  - The tests above, in `test/ending.test.ts`.
  - The README's "Hot swaps, cold swaps, and restarts", "Hangs and watchdogs", `status()`, and the error table.

## Implementation

- In `src/instance.ts`, `Instance.end()` terminates the Worker and waits for its `close` event, and `terminatedAt` records when the rack terminated it. `timedOut()` tells a request that the Worker didn't answer in time from one that the device failed.
- In `src/rack.ts`:
  - `#end()` is the one way to end an instance. It keeps the instances being ended in `#ending`, and the stuck threads in `#stuck`, each with its device's name, or none for a Worker that loaded firmware without one.
  - `#boot()` waits until no thread of the device is still being ended, then refuses while one of the device's threads is stuck, or one of the same firmware without a name. `#describe()` refuses in the same way.
  - `#powerDown()` runs the hooks of a stop and skips the rest after an unanswered one. `#retire()`, `#stopForReplacement()`, and `stop()` use it.
  - `#replaceCold()` fails when an old thread is stuck after the stop, before any new instance starts, and `#rollBackCold()` starts the old firmware of the other members.
  - When a hot swap fails, `#swapSlot()` activates the old instance again, or ends it and recovers the slot through `#crashed()`.
  - `#reset()` faults the slot while a thread of the device is stuck, without counting another crash.
  - `#unplugSlot()` keeps a device whose thread is stuck, and `#finishChange()` reports that as a failed unplug.
  - `#endAll()` waits for the threads together, at `stop()` and when a start fails.
- After a watchdog bite whose thread is stuck, the slot's error stays the bite's, as [Watchdog](261117_062959-watchdog.md#biting) decides. `status()` shows the thread in `stuck`.
- `test/ending.test.ts` holds the tests above. Those that block a thread with a FIFO are skipped on Windows, which has no `mkfifo`.

## Confirmation

- The user accepted this decision on 2026-11-17, together with [Counters for calls from outside the rack](261117_185225-outside-call-metrics.md), after asking for both limits that P2 left documented to be decided together.
