# Decision: The main thread runs no devices, and what child processes, connected racks, and single executables must meet

Status: accepted

## Background

- [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#installation-forms) plans three forms: `sled`, one Worker per device; `inline`, the rack's main thread, for small devices sensitive to call latency; and `chassis`, a child process. Only `sled` is built. [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope) left the other two, connecting racks through a top-of-rack switch, and `bun build --compile` packaging for later stages, and each needs a decision before work starts.
- The `inline` form sits badly with the rest of the design:
  - The main thread never imports device code, since it keeps every module it loads, as [The main thread never loads device code](261112_035943-hot-swap.md#the-main-thread-never-loads-device-code) says and hard constraint 2 of `AGENTS.md` requires. An `inline` device would be the exception.
  - [Watchdog](261117_062959-watchdog.md#impact) notes that no watchdog in the main thread can watch a device that runs there.
  - An uncaught exception in an `inline` device would end the rack, while one in a Worker ends only its device.
  - An `inline` device's resources are released only if it binds them to `ctx.signal`, while ending a Worker releases everything its device opened.
- Devices in other processes and connected racks both need links that cross processes. [Backplane protocol with direct links between devices](261116_024226-backplane-links.md#impact) notes that `MessagePort` links work only between threads of one process, so each must bridge its links to a transport of its own.
- The management endpoint already reaches a rack from another process: on Linux and macOS through a Unix socket that file permissions guard, and on Windows through loopback TCP with a token, as [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#transports) decides.
- On 2026-11-19, the user set the direction:
  - "For the main thread, I think it's more reasonable to keep the various monitoring and auxiliary logic of the rack there rather than using it to run devices."
  - "For running devices in separate processes and for multiple racks, we'd need to consider communication. On Linux, socket/TCP can be used; on Windows, only inter-process communication or TCP. Socket and TCP should keep one simple and reliable authentication method to prevent unauthorized access."
  - "Single-executable packaging needs to be supported, and it must be able to load devices outside the single executable as well as fall back to devices inside the packaged file."
  - As next steps, the user chose the README and the documentation, and then trial apps that an independent agent builds on rack42u.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since the thread that supervises the devices runs none of them, and every fault of a device stays in its own thread or process;
  - maintainability, since one form fewer is one path fewer to build, document, and test.

## Decision

### The main thread runs no devices

- The rack's main thread runs the rack itself: the wiring of the backplane and the calls from outside the rack, the states of the slots, power sequencing, swaps, the supervision of devices, the management endpoint, counters, and the log. It runs no device.
- The `inline` form is dropped. Devices run as `sled`, one Worker each, which stays the default, or later as `chassis`, in a child process.
- Hard constraint 2 of `AGENTS.md`, that the main thread never imports device code, has no exception, and hard constraint 4 loses its clause on `inline` devices.

### Child processes and connected racks

The decisions for the `chassis` form and for connected racks meet these requirements:

- **Transports.** Links between processes run on a Unix socket or TCP on Linux and macOS, and on a pipe between the processes or TCP on Windows.
- **Authentication.** Every connection on a socket or TCP is authenticated before it carries anything, so that no other user or machine can use it. One method serves both transports, and it is simple enough to get right and to test, such as the token of the management endpoint.
- **Their own decisions.** Each states, as [Design goals and principles](261117_062916-design-principles.md#feature-decisions) requires, the goals it serves, the failure modes it handles, its bounds, how an operator observes it, and how tests exercise its failures. Each also settles what the requirements leave open, such as how links between machines are protected in transit.

### Single executables

The decision for packaging a rack with `bun build --compile` meets these requirements:

- A rack app can be packaged into one executable, with its devices inside it.
- The executable loads a device from a file outside it when there is one, and otherwise falls back to the device packaged inside it.
- The decision settles when a device falls back, such as for a file that is missing, fails to build, or fails its probation, and how a device outside the executable resolves `rack42u`.

### Order

- The documentation and the trial apps come first, as the user chose. These features follow when the user decides.

## Alternatives

- **Keep `inline` for small devices sensitive to latency:** it would save the hop between threads, about 10 µs per call as the hot swap decision estimates it. But no watchdog could watch such a device, its crash would end the rack, and its code would stay loaded for good, against hard constraint 2 and the first goal, reliability.
- **Decide the transports and the authentication now:** they depend on how the `chassis` form and connected racks work, which no one has designed yet. The requirements keep the user's direction until then.
- **Record the direction in `AGENTS.md` only:** its rules summarize decisions, as its own rules say, so the direction needs a decision behind it.

## Impact

- Every device costs a Worker, about 3 MB, as now, and no device can save the hop between threads.
- The `inline` form was never built, so no code or test changes, and no app breaks.
- How the accepted decisions this one affects are handled once it is accepted:
  - [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#installation-forms): its `inline` row, its rule for the resources of `inline` devices, and the parts of the main thread in [The main thread never loads device code](261112_035943-hot-swap.md#the-main-thread-never-loads-device-code) give way to this decision. The decision is broad, so it stays as it is, with this note, as with [Panels as devices](261118_070617-panels-as-devices.md#impact).
  - [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope): of the later stages it lists, the `inline` form drops out. It stays as it is, with this note.
  - [Watchdog](261117_062959-watchdog.md#impact): its note that a decision for the `inline` form must say how such a device is supervised has no decision left to apply to. It stays as it is, with this note.
- `AGENTS.md`, once it is accepted:
  - Hard constraint 4 becomes: "Background tasks start only after `activate` and stop in `deactivate`." `AGENTS.md` requires an accepted decision to change a hard constraint; this decision is that one.
  - The architecture overview drops the `inline` device from its diagram.
  - The glossary's Form entry becomes "`sled` (Worker), `chassis` (child process, not built yet)".
  - "Current state" names this decision, and lists the `chassis` form, connected racks, and single executables as waiting for their decisions.
- The README's "Not supported yet" drops the `inline` form, and lists running devices in child processes, connecting racks, and single executables.
- Follow-up: the decisions for the `chassis` form, connected racks, and single executables, when the user decides.

## Implementation

- `AGENTS.md`: hard constraint 4 without its clause on `inline` devices, the architecture overview without an `inline` device, the glossary's Form entry, and the requirements in "Current state".
- The README's "Not supported yet" says that devices run only in Workers, and lists child processes, connected racks, and single executables.
- The implementation notes of [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#implementation) say that this decision drops the `inline` form.

## Confirmation

- The user accepted this decision on 2026-11-19, together with the two other decisions drafted that day, after reviewing them: "Approved, all of them. Get to work."
