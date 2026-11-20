# Concepts

rack42u names its parts after a server rack. The names make the parts easy to picture; they don't set what the parts do. This page explains each part and how the parts work together, and links to the guide that shows how to use it.

| Term | Meaning |
|---|---|
| Rack | One process. 42U by default; the size is configurable. |
| Slot | A position in the rack, numbered from 1 at the bottom. |
| Device | A module in one file that occupies one or more U. Each device runs in its own Worker. |
| Connector | A named, versioned contract of RPC methods and events, such as `kv/v1`. |
| Port | One connector on a device, addressed as `<device>.<port>`. |
| Backplane | The only channel between devices. Devices never import each other. |
| Link | A direct channel the backplane sets up from one device's need to another device's port. Calls and events between devices travel on links, Worker to Worker, without passing through the rack's main thread. |
| Patch | An explicit connection, needed when several devices provide the same connector. |
| Panel | A device that owns external connections, such as the standard [HTTP panel](guides/http.md), and passes the work to other devices through the backplane. |
| Listener | An HTTP server, WebSocket included, that a device opens with `ctx.serve()`, and that the rack hands over when the device swaps. |
| Firmware | The hashed bundle a device file is built into; the hash is its version. |
| Swap | The one process behind replace, hot reload, plug, and unplug. |

## The rack

A rack is one Bun process that holds devices in slots, 42U of them unless its manifest sets another `size`. Its main thread runs the rack itself, and no device: it builds firmware, starts and stops devices, wires them together, supervises them, counts the calls from outside the rack, and answers the management endpoint. It never imports device code, since a module it loaded would stay loaded for good; a manifest names device files by path instead. [Racks](guides/racks.md) shows the two kinds of manifest: one that places devices in slots by hand, and one that scans directories of device files and works out the slots.

## Devices

A device is a module in one file, and each device runs in a Worker of its own. It declares:

- the connectors it **provides**, as ports that other devices and the outside call;
- the connectors it **needs**, which the rack wires to ports of devices below it;
- its **configuration**, with a schema the rack validates it against;
- its **hooks**, which the rack calls as the device starts, serves, and stops.

A device keeps its state in memory or hands it to a storage device; in-memory state moves to a new instance only through `snapshot` and `restore`. [Devices](guides/devices.md) shows how to write one.

## Connectors and ports

A connector is a contract with a name and a major version, such as `kv/v1`: RPC methods with schemas for their input and output, and events with schemas for their payloads. Calls can also stream bytes. A port is one connector on a device, addressed as `<device>.<port>`.

The schemas come from any library that implements Standard Schema, such as valibot or zod, and the rack checks data against them where it crosses from one device to another. A connector whose contract changes in a way its consumers can't follow gets a new major version. [Connectors](guides/connectors.md) shows how to define one.

## The backplane and links

The backplane is the only channel between devices: devices never import each other and never hold each other's objects. It wires each need to a port of a device below: by itself when exactly one device there provides the connector, and by a patch when several do.

For each wired need, the backplane sets up a link, a channel from the consumer's Worker straight to the provider's. Calls and events travel on the link, so the rack's main thread stays out of their way. When a device is swapped or reset, the backplane moves its links to the new instance, and the other devices keep their own.

Data that crosses the backplane is copied, unless a call moves or shares its buffers as [Binary data and streams](guides/data.md) describes, so devices share no objects. Errors cross as codes: a `RackError` keeps its code and data, and the rack's own codes start with `RACK_`, as the [error codes](reference/errors.md) list them.

## The gravity rule

A device may depend only on devices in lower slots. So the rack powers devices on from the bottom up and off from the top down: storage sits low, entry points such as panels sit high, and a provider is always running before its consumers start and after they stop. A lower device that has news for an upper one emits events, which the upper one subscribes to. In a scanned rack, the plan places each device above what it needs, and a cycle fails at startup, as [Racks](guides/racks.md#shared-instances-and-own-copies) describes.

## Firmware

The rack builds each device file into one bundle, its firmware, with the content hash in its file name. The hash is the firmware's version: a rebuild that gives a device the same hash leaves it running, and one that gives it a new hash replaces it. The framework and the app's declared dependencies stay outside the bundle, so firmware stays small, and every device loads them from the app's `node_modules`. In the bundle, `import.meta` keeps naming each file's source, as [A device file](guides/devices.md#a-device-file) describes. The rack keeps the firmware of earlier versions while it can still go back to them, as [Updates](guides/updates.md#history) describes.

## The lifecycle

Each instance of a device goes through its hooks in this order, and all of them but `powerOn` are optional:

```text
powerOn ─► selfTest ─► activate ⇄ deactivate ─► powerOff
```

`powerOn` returns the implementation of the device's ports, and `selfTest` can refuse to go into service. Background work, such as timers and work loops, starts in `activate` and stops in `deactivate`, because during a swap two instances of a device briefly run side by side. [Devices](guides/devices.md#hooks) gives the details.

## Swaps

One process, the swap, replaces, reloads, plugs, and unplugs devices while the rack runs.

- A **hot swap** starts the new instance before the old one stops. Calls in flight finish on the old instance, new calls wait for a moment and then go to the new one, and the in-memory state moves through `snapshot` and `restore`. Requests are made before they are broken, and background work breaks before it makes: it stops on the old instance before it starts on the new one.
- A **cold swap** stops the old instance first, for a device that must never run twice at once, such as one that holds a file lock.
- A **restart** starts a device from scratch, without its state.

If a step fails, the device goes back to its old firmware. `rack dev` swaps each device whose firmware changed, and an edited manifest or a changed plan becomes a series of swaps too. [Updates](guides/updates.md) describes them all.

## Faults

The rack contains a fault to the device that has it, and recovers along a defined path:

- A device that **crashes** is reset from the same firmware. One that crashes more than 3 times within 60 seconds is marked `faulted`, until a swap succeeds.
- A device that **hangs** is caught by a watchdog: the rack's own on its event loop, or one the device feeds from a work loop. A bite resets the device as a crash does.
- A thread **stuck** in native code can't be stopped. The rack waits for it within bounds, and starts no second instance of the device meanwhile.
- **Overload** stays bounded: every queue between devices has a limit, and work beyond it fails at once with `RACK_OVERLOADED`.
- An **update** that crashes or hangs while it is on probation falls back to the firmware that last worked, and `rollback()` undoes an update on request.

[Faults and overload](guides/faults.md) and [Updates](guides/updates.md#fallback) give the rules and the limits.

## Panels and listeners

External connections belong to devices. A device opens HTTP and WebSocket listeners with `ctx.serve()`, and the rack hands them over when the device swaps, so that a port keeps answering. A panel is a device whose job is such connections: the standard [HTTP panel](guides/http.md) routes requests and WebSocket messages to ports of other devices. [Listeners](guides/listeners.md) describes the handover and its limits.

## Watching a rack

A running rack reports what it does: `status()` gives each device's state and firmware, `metrics()` counts calls and events, `history()` lists the updates, and the log says what the rack and each device did. `rack ctl` reaches the same operations from a terminal, through a management endpoint that only the rack's user can use. [Managing a running rack](guides/managing.md) and [Reports](reference/reports.md) describe them.
