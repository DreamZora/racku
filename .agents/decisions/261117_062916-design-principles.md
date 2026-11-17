# Decision: Design goals and principles

Status: accepted

## Background

- rack42u names its parts after a server rack: slots, devices, a backplane, firmware, a panel. The names make an unfamiliar system easy to picture.
- [Rack runtime architecture](261112_035942-rack-architecture.md#reliability-and-management) goes further and lists capabilities of physical racks as settled in concept: a circuit breaker, thermal, a watchdog, a power-on self-test, an indicator LED, a management controller, and a top-of-rack switch. Planning P2 raised the question whether the breaker and thermal should be built as listed.
- On 2026-11-17 the user set the direction:
  - rack42u borrows rack concepts to make the system easier to understand. It doesn't have to copy the physical world.
  - Features, design goals, and implementation follow from reliability, maintainability, observability, and extensibility.
  - The project takes in the Linux philosophy of simplicity, and the pursuit of reliability in industrial, automotive, and aerospace systems.
  - JavaScript can't be as predictable as C, so the project strives to be as reliable as it can.
- No decision states these goals yet. Each decision argues its tradeoffs from scratch, and a concept can become a feature only because the metaphor has it.

## Decision

### Goals

Every feature serves these goals. When they conflict, the earlier goal wins.

1. **Reliability**: the rack keeps serving what it can. Every fault is detected, contained to its device, reported, and recovered from along a defined path.
2. **Maintainability**: each part can be understood, changed, and tested on its own.
3. **Observability**: an operator can see what the rack is doing, what it did on its own, and why.
4. **Extensibility**: builders add capabilities as devices and connectors, without changing the core.

### Simplicity

From the Linux philosophy:

- Each mechanism does one thing and composes with the others.
- The rack provides mechanisms, and devices and manifests set policy. For example, the rack bounds calls and times them out; a device decides whether to retry.
- An existing path is reused before a new one is added. For example, a hung device is reset through the same path as a crashed one.
- State and interfaces are plain data a person can read: text files, JSON, structured logs, and error codes.
- Options are few, and each has a safe, documented default.

### Reliability practices

From industrial, automotive, and aerospace engineering:

- **Bounded**: every queue, backlog, retry, record, file, and wait has a fixed limit.
- **Timed**: every wait has a timeout, and every timeout has a defined outcome.
- **Contained**: a fault in one device doesn't stop other devices or the rack.
- **Explicit**: a failure fails fast, with a structured code. Nothing fails silently, hangs, or retries without limit.
- **Supervised**: what can hang is watched, and what can crash is restarted within a limit. The rack process itself is supervised by the service manager, such as systemd.
- **Recoverable**: there is a known-good state to return to, and every change can be undone.
- **Deterministic**: fixed, declared limits and explicit states come before adaptive heuristics, so that behavior under faults and overload can be predicted and tested.
- **Validated**: data is checked at every boundary, with schemas on ports and configuration, and checks on manifests and plans.
- **Tested in failure**: tests inject crashes, hangs, timeouts, overload, and bad updates, not only the paths that work.

### Limits of JavaScript

- Bun and JavaScript don't give the timing guarantees of C on a real-time system. Garbage collection pauses the code, each thread runs one event loop, types are checked only where schemas check them, and devices run third-party code.
- Within those limits, "as reliable as possible" means that every known failure mode has a detection, a bound, a recovery, and a test. Where a guarantee isn't possible, the documentation states the limit instead of implying the guarantee.

### Borrowed concepts

- Rack terms name things. They don't prescribe behavior.
- A physical concept becomes a feature only when it serves a goal through a mechanism that suits software. Otherwise it is reshaped or dropped.
- The capabilities that [Rack runtime architecture](261112_035942-rack-architecture.md#reliability-and-management) lists as settled in concept are candidates. The decision for each one adopts, reshapes, or drops it against these goals. Where the two decisions differ, this one comes first.

### Feature decisions

- A decision for a feature states, within its usual sections, which goals it serves, which failure modes it handles, its bounds, how an operator observes it, and how tests exercise its failures.
- [AGENTS.md](../../AGENTS.md) carries these rules in short form and links here.

## Alternatives

- **Keep the goals implicit**: nothing new to follow. But each decision keeps arguing its tradeoffs from scratch, and the breaker and thermal would be built because the metaphor lists them.
- **Leave the goals unordered**: no ranking to agree on. But a conflict, such as an extension point that would leave a queue unbounded, would have no rule to settle it.
- **Adopt a safety standard, such as IEC 61508, ISO 26262, or DO-178C, or MISRA-style coding rules**: proven and complete. But they assume static languages, qualified toolchains, and certification work far beyond a JavaScript framework. This decision takes their practices, not their processes.
- **Build the physical concepts as listed**: familiar to anyone who knows racks. But a fuse or a thermal sensor doesn't map one-to-one onto software, and copying them adds mechanisms that no goal asks for.

## Impact

- AGENTS.md gains a "Design principles" section that summarizes this decision.
- Feature decisions from now on state their goals, failure modes, bounds, observation, and failure tests.
- Measured against these practices, the rack has known gaps. P2 proposes decisions for the first three:
  - A device that hangs without crashing goes unnoticed: [Watchdog](261117_062959-watchdog.md).
  - A need can have any number of calls in flight, and a subscriber any number of events waiting. A provider also runs calls whose deadline has passed: [Bounded backlogs instead of a breaker and thermal](261117_063228-bounded-backlogs.md).
  - The checks run on one Linux machine, while the README describes behavior on macOS and Windows: [Continuous integration on GitHub Actions](261117_063301-continuous-integration.md).
  - Nothing limits the rate of a device's log entries, and payload sizes are bounded only where a connector's schema bounds them.
  - Nothing supervises the rack process; that belongs to the service manager.
  - The update history and the known-good firmware are lost when the rack restarts.
- The last three gaps need decisions of their own.
- [Rack runtime architecture](261112_035942-rack-architecture.md) keeps its content, and its list of capabilities is read through this decision.

## Confirmation

- The user accepted this decision on 2026-11-17. The user set the four goals, the Linux philosophy of simplicity, the reliability practices of industrial, automotive, and aerospace systems, and the limits of JavaScript, and asked that AGENTS.md carry them.
- The Agent organized them into rules. The order of the goals follows the order in which the user named them.
