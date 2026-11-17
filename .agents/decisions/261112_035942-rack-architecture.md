# Decision: Rack runtime architecture

Status: accepted

## Background

- The framework uses the 42U rack as its analogy. An analogy is only worth making when every hardware concept maps to a real engineering mechanism; renaming things alone makes the analogy meaningless.
- Every device must support hot swap (see [Every device supports hot swap and hot reload](261112_035943-hot-swap.md)), so devices must not hold references to each other.

## Decision

### Basic units

- **Rack**: one process, and also one deployment unit. Capacity defaults to 42U and is configurable. A full rack means the process carries too many responsibilities and should be split into a second rack.
- **Slot**: a position in the rack, numbered from 1 upward.
- **Device**: a hot-swappable module that occupies one or more U. A device declares the connectors it needs (`needs`), the connectors it provides (`provides`), and its lifecycle hooks. Each device is a single file and is a default export.
- **Connector**: a contract with a name, a version, and a schema, for example `kv/v1`, made up of RPC methods and events. The schema follows the Standard Schema specification and is not tied to a specific validation library.
- **Port**: one instance of a connector on a device, addressed as `<device>.<port>`.
- **Backplane**: the only communication channel between devices, and it routes RPC calls, events, and streams. The backplane is "passive": it handles only routing and power sequencing and contains no business logic, so it rarely needs replacing.
- **Patch**: an explicit connection between devices. When a connector has exactly one provider, the backplane connects automatically; when there are several providers, a patch must specify which one to connect.
- **Panel**: the ports the rack exposes to the outside world, such as HTTP and WebSocket. The rack owns the ports, and devices supply only the handling logic.

### Gravity rule

- A device may depend only on devices in lower slots. By convention, configuration and secrets sit at the bottom, then storage, then business logic, with the external entry point at the top.
- Cold start powers devices on from the bottom up. Shutdown powers devices off from the top down: stop accepting traffic first, then finish the work in progress, and finally write data back to storage and shut storage down.
- This rules out circular dependencies, and the rack elevation drawing is itself the dependency graph.
- When a lower device needs to notify an upper one, the upper device subscribes to the events the lower device emits.

### Three buses

- **Power bus**: carries lifecycle commands, including power on, power off, reset, and degrade.
- **Data bus**: carries business calls and events.
- **Management bus**: carries health checks, metrics, resets, swaps, and other management commands that are independent of business traffic, and it is separate from the data bus. When a device runs in a Worker, the management bus uses a separate MessagePort, so management commands still arrive while the data bus is congested.

### Reliability and management

The following capabilities are settled in concept; each gets its own decision before implementation starts:

- **Circuit breaker (breaker)**: a fuse.
- **Thermal**: computed from the number of calls in flight, the queue length, and the event-loop delay, and used to rate-limit and drop requests.
- **Watchdog**: resets a device when its heartbeat times out.
- **Power-on self-test (POST)**: a device that fails self-test receives no traffic.
- **Indicator LED (LED)**: device status, one of online, degraded, faulty, and powered off, reported over the management bus.
- **Management controller (BMC)**: provides status inspection and remote operations over the management bus.

Because devices hold only addresses, a reset or swap of a lower device does not require restarting the devices above it.

### Multiple racks

- A **top-of-rack (ToR) switch device** extends the backplane to other racks, that is, other processes or other machines. Device code does not change; only the rack manifest does.

## Alternatives

- **Order devices by the dependency graph automatically and use slots only for display**: the topological order is not necessarily unique, slots lose their real meaning, and "the elevation drawing is the dependency graph" no longer holds. The gravity rule uses position to express both layering and start order, and validates it at assembly time.
- **Let devices import each other's instances directly, or receive instances through dependency injection**: calls are fastest, but a device can then neither be swapped on its own nor moved into a Worker or another process, and calls cannot be traced uniformly.
- **Require an explicit patch for every connection**: the intent is clear, but writing it is verbose. A real blade chassis also connects as soon as a blade is plugged into the backplane, so a patch is required only when the target is ambiguous.

## Impact

- All interaction between devices goes through the backplane, which adds one routing hop even within the same process.
- Data sent over ports must be copyable by structured clone; functions and class instances cannot be passed.
- The gravity rule forbids lower devices from depending on upper ones, so some designs must become event subscriptions.
- Reliability, management, and multiple-rack capabilities are delivered in stages, each with its own decision at that point.

## Implementation

- Standard Schema validation of connector schemas: `validate`, `formatIssues`, and `isStandardSchema` in `src/schema.ts`, tested in `test/schema.test.ts`.
- Rack runtime: assembly, the gravity rule, and power sequencing in `src/rack.ts`; the backplane in `src/backplane.ts`; tested in `test/rack.test.ts`.
- The power-on self-test is the `selfTest` hook. The watchdog is implemented as [Watchdog](261117_062959-watchdog.md) decides, and [Bounded backlogs instead of a breaker and thermal](261117_063228-bounded-backlogs.md) takes the place of the circuit breaker and thermal. The indicator LED, management controller, and top-of-rack switch are not implemented yet.

## Confirmation

- Drafted by the Agent along the direction agreed with the user. On 2026-11-12 the user authorized the Agent to decide routine decisions on its own, and this decision was set to `accepted` on that basis.
