# Decision: Counters for calls from outside the rack

Status: accepted

## Background

- [Call and event metrics](261116_035534-call-metrics.md) counts calls in the Workers. A provider counts the calls it serves. A consumer counts the calls of its needs, including those that fail before they leave it, such as refusals at `queueLimit`.
- Calls from outside the rack, through `call()` and the panel, have no consumer Worker: the main thread routes them. When the main thread answers such a call itself, no Worker sees it, so nothing counts it:
  - a call refused at `queueLimit` with `RACK_OVERLOADED`, which the panel answers with 503;
  - a call held while its device swaps or resets, until its deadline passes: `RACK_TIMEOUT`, which the panel answers with 504;
  - a call to a device that is `faulted` or `resetting`: `RACK_LINK_DOWN`, 503;
  - a call to an address or member that doesn't exist, such as a panel route to a device that was unplugged: `RACK_NO_ROUTE`;
  - a call cancelled before it reached its device: `RACK_CANCELLED`.
- So while the panel answers 503 or 504, `metrics()` and `rack ctl metrics` look healthy, and only the HTTP clients see the errors. [Bounded backlogs](261117_063228-bounded-backlogs.md#implementation) left the refusals uncounted for a decision of their own.
- Logging each of these failures isn't a fix: the log has no rate limit yet, a gap that [Design goals and principles](261117_062916-design-principles.md#impact) lists.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: observability, since an operator sees what the rack refused or timed out on its own, and why.

## Decision

- The main thread counts the calls from outside the rack, through `call()` and the panel, the way a device counts the calls of a need: per port and member, with the fields of `CalledRpcMetrics`.
  - `calls`, `ok`, and `errors` by code count every outcome, wherever it happened: refused, held past the deadline, sent to a device that wasn't serving, cancelled, failed by the device, or answered.
  - `pending` counts the calls not finished yet, and `queued` the ones among them held while their device swaps or resets.
  - `timeMs` is the total time from the call to its result of the finished calls.
- `metrics()` returns them as `outside`:

  ```ts
  interface RackMetrics {
    devices: DeviceMetrics[];
    /** Calls from outside the rack, through call() and the panel. */
    outside: OutsideMetrics;
  }

  interface OutsideMetrics {
    /** By address, `<device>.<port>`, then by member. */
    ports: Record<string, Record<string, CalledRpcMetrics>>;
    /** Calls to an address or member that didn't exist, which failed with RACK_NO_ROUTE. */
    unrouted: number;
  }
  ```

- A call counts under its port and member when both exist as it is made, and in `unrouted` otherwise. So the counters stay bounded by the ports and members in the rack, whatever addresses callers use.
- The counters last across swaps and resets, since the callers outside the rack don't change when a device does. A port's counters start at its first call, and go away when its device is unplugged; a member's go away when a swap removes it.
- The panel's calls count under the member `handle` of the port its route names, such as `web.http`.
- After `stop()`, `metrics()` resolves with no devices and with empty `outside` counters.

### Tests

- A panel request and a `call()` refused at `queueLimit` count under `errors.RACK_OVERLOADED` of their port and member.
- Calls held during a cold swap count in `queued` while they wait, and under `RACK_TIMEOUT` once their deadline passes.
- A call to a `faulted` device counts under `RACK_LINK_DOWN`, and a call to an unknown address or member counts in `unrouted`.
- Answered calls count in `ok` and `timeMs`. The counters of a device's ports survive its swap, and go away when it is unplugged.

## Alternatives

- **Count only the calls the main thread answers itself, per device and code**: a smaller change. But the callers' view of the calls that reach a device would stay missing, such as how long they took including the time they were held, and the shape would differ from every other counter.
- **Put the counters in `DeviceMetrics`**: one entry per device. But `DeviceMetrics` comes from the device's instance and starts over at each swap, and a `faulted` device has no instance to report at all, which is when its refused calls matter most.
- **Count the panel and `call()` apart**: finer. But both reach the same ports, and the panel's routes already show which port serves HTTP.
- **Count HTTP statuses in the panel**: closer to what HTTP clients see. But calls through `call()` would stay uncounted, and error codes say more than statuses.

## Impact

- An operator sees in `metrics()` and `rack ctl metrics` what callers outside the rack got, including the calls the rack refused or timed out on its own.
- `RackMetrics` gains `outside`. Code that compares a whole `metrics()` result has to allow for it.
- Each call from outside the rack gets a few counter updates and two clock reads on the main thread, about 50 ns by the measurement of [Call and event metrics](261116_035534-call-metrics.md#evidence).
- Follow-up work once this decision is accepted:
  - The counters in `src/backplane.ts`, the `OutsideMetrics` type in `src/metrics.ts`, and `metrics()` in `src/rack.ts`.
  - The tests above, in `test/metrics.test.ts`.
  - The README's metrics section and its "Overload" section, which says that no device counts refused calls from outside the rack.

## Confirmation

- The user accepted this decision on 2026-11-17, together with [Ending instances and stuck threads](261117_185131-ending-instances.md), after asking for both limits that P2 left documented to be decided together.
