# Decision: Bounded backlogs instead of a breaker and thermal

Status: accepted

## Background

- [Rack runtime architecture](261112_035942-rack-architecture.md#reliability-and-management) lists two capabilities for overload as settled in concept:
  - a circuit breaker, "a fuse";
  - thermal, "computed from the number of calls in flight, the queue length, and the event-loop delay, and used to rate-limit and drop requests".
- On 2026-11-17 the user asked for careful consideration of both. rack42u borrows rack concepts to be easy to understand, and builds features from its goals, as [Design goals and principles](261117_062916-design-principles.md#borrowed-concepts) decides.
- What a breaker and thermal would protect against is overload and repeated failure. Today:
  - **Calls**: a need can have any number of calls in flight. Only calls that wait while their provider is held for a swap are bounded, at 10 000. A provider that is slower than its callers collects their calls in its Worker's message queue without limit, until memory runs out. The process then fails, and a fault in one device takes down all of them.
  - **Events**: a subscriber that handles events more slowly than its provider emits them collects them without limit. Only events for a held subscriber are bounded, at 10 000, and counted as `dropped` beyond that.
  - **Stale calls**: a provider starts every call it receives, even one whose deadline passed while it waited. That call's caller has already failed with `RACK_TIMEOUT`. Under overload, the provider spends its time on calls nobody waits for, and its useful throughput collapses.
  - **Repeated failure**: a device that crashes more than 3 times within 60 seconds is already isolated. Its slot is `faulted`, and calls to it fail at once with `RACK_LINK_DOWN` until a swap succeeds. That is the fuse, and [Watchdog](261117_062959-watchdog.md#biting) extends it to hangs.
- A software circuit breaker opens after a rate of failures, and closes again after a cool-down and a trial call. Adaptive load shedding drops work when measured load crosses a threshold. Both make whether a call is accepted depend on recent traffic and timing.
- Envoy, a widely used proxy, implements what it calls circuit breaking as fixed limits on connections, pending requests, requests, and retries, without failure rates.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since overload stays within bounds and fails fast; and observability, since every refusal and drop is counted.

## Decision

### Bounded calls

- A need of an instance has at most `queueLimit` calls unfinished: sent and not yet answered, or waiting while the provider is held. `queueLimit` is a new start option, 10 000 by default, the bound that held calls already have.
- Calls from outside the rack, through `rack.call` and the panel, are counted per device they go to, on the main thread, with the same limit.
- A call beyond the limit fails at once, at the caller, with the new code `RACK_OVERLOADED`, and never reaches the provider.
  - A held call beyond the limit fails with `RACK_OVERLOADED` too, instead of `RACK_LINK_DOWN`, since the provider isn't down.
  - The refusal counts among the need's errors by code in `metrics()`.
- The panel answers `RACK_OVERLOADED` with `503 Service Unavailable`.
- A device may throw `RACK_OVERLOADED` for limits of its own, such as a pool of outgoing connections. Callers and the panel then treat it the same way.

### Bounded events

- A subscriber has at most `queueLimit` events waiting on its link, events that its Worker host hasn't taken yet. The subscriber's Worker host reports in batches how many it has taken.
- Beyond the limit, the provider drops the event for that subscriber and counts it in `dropped`, as it already does for a held subscriber. `emit` doesn't fail, and other subscribers still get the event.

### Stale calls

- When a call's deadline has passed before its implementation starts, the provider answers `RACK_TIMEOUT` at once, without running the implementation, and counts it among its errors.

### Not built

- **A breaker that opens on a failure rate**:
  - What counts as a failure depends on the application. A "not found" answer, for example, isn't one.
  - Its thresholds and cool-downs make acceptance depend on history, and a short blip can make it refuse healthy calls for a whole cool-down.
  - A consumer that wants one builds it as policy in its device, on top of the codes and counters the rack provides.
- **Thermal shedding and rate limiting by the rack**:
  - Accepting a call would depend on timing and measurements, so the same traffic would be treated differently from run to run.
  - The fixed limits above shed load predictably instead.
  - The signals thermal would read stay visible: `pending`, `active`, and errors by code in `metrics()`, and the event-loop delay that [Watchdog](261117_062959-watchdog.md#configuration-and-observation) adds.
- This decision takes the place of the breaker and thermal in [Rack runtime architecture](261112_035942-rack-architecture.md#reliability-and-management).

## Alternatives

- **A failure-rate circuit breaker in the rack**: see "Not built".
- **Thermal**: see "Not built".
- **Limit concurrency at the provider instead of at the caller**: the provider knows its capacity. But calls would still travel and queue before the provider could refuse them, and a provider with a busy event loop can't refuse anything until it runs again. Limiting at the caller keeps the backlog bounded even then.
- **A small default limit, such as Envoy's 1 024**: overload would show sooner. But a burst to a fast provider, such as `memkv`, would be refused although it would be served within milliseconds. The default is the bound that held calls already had, and builders who know their numbers lower it.
- **Separate limits for calls, held calls, and events**: finer control. But that is three numbers for one concept, the backlog between two devices.
- **Make `emit` fail when a subscriber is full**: the emitting device would know. But one slow subscriber would then stop events for all the others, and emitting is fire-and-forget by design.
- **Bound bytes instead of counts**: closer to what runs out. But measuring structured-clone data costs work on every call. Counts are cheap and deterministic, and a connector's schemas can bound sizes.

## Impact

- A slow or stuck device can no longer exhaust the process's memory through the backplane. Overload fails fast with `RACK_OVERLOADED`, and providers stop working on calls nobody waits for.
- Changes to current behavior:
  - A need with 10 000 unfinished calls refuses more. Before, only a held need did.
  - A held call beyond the limit fails with `RACK_OVERLOADED` instead of `RACK_LINK_DOWN`.
  - A provider no longer runs calls whose deadline has passed.
  - A subscriber 10 000 events behind misses events, counted as `dropped`.
- New public API: the error code `RACK_OVERLOADED`, the start option `queueLimit`, and the panel's 503 for it.
- The backplane protocol gains a message from a subscriber's host to its provider's host that reports how many events the subscriber took.
- Not covered here, as [Design goals and principles](261117_062916-design-principles.md#impact) lists: the rate of device log entries, which travel on the management bus, and payload sizes.
- Follow-up work once this decision is accepted:
  - The bounds in `src/worker.ts` and `src/backplane.ts`, the deadline check in the provider's `serve()`, the code in `src/errors.ts`, the status in `src/panel.ts`, and the option in `src/rack.ts`.
  - Tests:
    - a need at the limit refuses calls at once, and accepts calls again as others finish
    - calls from outside the rack at the limit fail, and the panel answers 503
    - a held need at the limit refuses with `RACK_OVERLOADED`
    - a provider answers an expired call with `RACK_TIMEOUT` without running it
    - a slow subscriber misses events beyond the limit, counted as dropped, while a fast one gets every event
  - README: the option, the code, and what overload looks like.

## Implementation

- `queueLimit` is a start option in `src/rack.ts`. The rack passes it to each Worker in the boot request, and to the backplane.
- `src/worker.ts`:
  - Each need counts its unfinished calls. `callOut()` refuses a call beyond the limit with `RACK_OVERLOADED` after the call has taken its buffers, as other early failures do, so held calls need no bound of their own.
  - Each subscriber link counts the events its provider sent. The subscriber's host reports the events it took in `taken` messages, once per quarter of `queueLimit` events and at least once per 256, so a subscriber that keeps up never looks full. A provider drops an event for a link whose backlog has reached the limit, and events for a held subscriber use the same limit.
  - `serve()` answers a call whose deadline has passed with `RACK_TIMEOUT` before it validates or runs anything.
- `src/backplane.ts` counts the unfinished calls from outside the rack on each slot, in `Slot.unfinished`. Each call remembers the slot that counted it, so an unplug and a new plug under the same name can't upset the count.
- `src/protocol.ts` carries `queueLimit` in the boot request and the `taken` message. `src/errors.ts` adds `RACK_OVERLOADED`, and `src/panel.ts` answers it with 503.
- A refused call from outside the rack reaches only its caller: no device saw it, so `metrics()` doesn't count it. Counting it on the main thread would need a decision of its own.
- `test/backlogs.test.ts` tests the decision. Twelve deliberate breaks, such as no limit, counts that never drop, subscribers that never report, or providers that run expired calls, each made one of its tests fail.

## Confirmation

- The user accepted this decision on 2026-11-17, after asking that the breaker and thermal be judged against the project's goals instead of copied from physical racks.
- The user accepted one `queueLimit` of 10 000 for calls, held calls, and events, as drafted.
