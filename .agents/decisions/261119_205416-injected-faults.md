# Decision: Faults that tests inject into a device

Status: accepted

## Background

- Issue #13, from the trial of the `watcher` app: its check had to show that a checker recovers from a crash and from a hang. Nothing in rack42u can make a device crash or hang on demand, so the agent put a switch in the device, behind an environment variable, that crashes or hangs it on a certain answer: test code in a device that runs in production.
- Testing a device now says what a test can do instead: `restart()` starts a device again without its state, as the reset after a crash does, and a stub fails as a crashed or hung provider would. Neither runs the paths of a real crash or hang of the device under test: the uncaught exception, the watchdog's bite, the reset, the crash limit, and fallback during probation.
- [Design goals and principles](261117_062916-design-principles.md#reliability-practices) asks for tests that are "tested in failure": "tests inject crashes, hangs, timeouts, overload, and bad updates, not only the paths that work". rack42u's own tests do it with fixture devices made to fail; an app's tests have only their real devices.
- Goals, as [that decision](261117_062916-design-principles.md#goals) defines them:
  - reliability, since an app can test its recovery from crashes and hangs through the same paths as a real fault;
  - maintainability, since devices keep no test code for it.

## Decision

### injectFault

- The rack handle gains `injectFault(name, kind)`, and the bench `injectFault(kind)` for its device. `kind` is one of these:
  - `"crash"`: the device's Worker throws an uncaught exception, from a task of its own, outside any hook or call, as a device's code would. The rack handles it as any crash: the calls in flight fail with `RACK_DEVICE_FAULT`, and the rack resets the device, or falls back during probation.
  - `"hang"`: the device's Worker blocks its event loop until the event-loop watchdog bites, after `watchdog` milliseconds. The rack handles the bite as any other.
- It resolves once the device's Worker has taken the fault, before the crash or the bite.
- The fault's error, in `faults`, the `fault` event, and `status()`, says that it was injected: `injected crash`, or the watchdog's usual message after an injected hang.
- The rack logs `<device>: injecting a <kind>` as a warning first, so the log tells an injected fault from a real one.

### Who may inject

- `start()` takes `faultInjection: true` to allow it; it is off by default, so a rack in production refuses. `rack start` and `rack dev` have no flag for it, and `rack ctl` no operation: injected faults are for tests that run a rack from code.
- The bench always allows it, since it exists for tests.
- A refused injection fails with `RACK_SWAP_REJECTED`, as the rack refuses a swap, without touching the device; the description of that code names the injection too.

### Failure modes

| Failure | Outcome |
|---|---|
| `injectFault()` on a rack started without `faultInjection` | refused; the device keeps running |
| `"hang"` while watchdogs are off, `watchdog: 0` | refused, since nothing would end the hang |
| The device has no installed instance: it is resetting, faulted, or not plugged | `RACK_LINK_DOWN`, as for a call |
| Injected faults beyond the crash limit | the slot is `faulted`, as after real ones: that path is among those to test |

### Bounds

| What | Bound |
|---|---|
| An injected hang | the event-loop watchdog's timeout, `watchdog`, 10 000 ms by default |
| Injected faults | count toward the crash limit, as real ones do |

### Protocol

- The main thread sends the device's Worker host a `fault` message with its kind. The host answers once it has scheduled the fault, then throws or blocks from a task of its own.

### Tests

- On the bench, an injected crash resets the device, which loses its in-memory state, and `faults` records it as injected.
- On the bench with a `watchdog` of 1 000 ms, an injected hang ends with the event-loop watchdog's bite within 1.25 s, and the device is online again.
- A rack started without `faultInjection` refuses, and so does a hang while watchdogs are off.
- Injected crashes beyond the crash limit leave the slot `faulted`, and during probation, one falls back to the known-good firmware.

## Alternatives

- **A switch inside the device,** the trial's workaround. It puts test code into every device that must be tested this way, and into production with it.
- **A copy of the device made to fail,** swapped in for the test. It tests the copy, not the device.
- **Terminating the device's Worker from the main thread.** A device never ends that way: it skips the uncaught exception, its log and source map, and the watchdog, and can't stand for a hang.
- **Injection on the bench only.** Simpler, but the trial's check ran its whole app with `start()`, where the bench doesn't reach.

## Impact

- Gains: an app tests its recovery from crashes and hangs through the paths of real ones, with no test code in its devices.
- Costs: a public method on the rack handle and the bench, a `start()` option, and a message of the protocol between the main thread and a Worker host.
- Follow-up: the testing guide replaces the sentence that rack42u has no way to cause a crash or a hang with `injectFault`.

## Confirmation

- The user accepted this decision on 2026-11-19, with the answers it proposed to its open questions: a refused injection fails with `RACK_SWAP_REJECTED`, and the kinds are `"crash"` and `"hang"`, since the rack handles every crash the same way. The user's words: "All approved — handle them in order."
