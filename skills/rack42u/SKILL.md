---
name: rack42u
description: Build, test, and change apps on rack42u, the Bun framework whose apps are hot-swappable devices mounted in a rack. Use when an app depends on rack42u, to write connectors, devices, or rack manifests, to test a device on the bench, to run a rack with `rack start` or `rack dev`, or to read what a running rack reports.
---

# rack42u

An app on rack42u is made of **devices**: modules of one file each, which the **rack**, one Bun process, runs in Workers of their own. Devices talk to each other only through the rack's **backplane**, by **connectors**, contracts with schemas, and the rack can replace any device while the others keep serving.

The documentation ships with the package, and this skill names each document by its path in the app's directory: `node_modules/rack42u/README.md`, and the map of the rest, `node_modules/rack42u/docs/README.md`. A `#` after a path names a section, by the anchor of its heading. Read `node_modules/rack42u/docs/getting-started.md` first: it builds a whole app in a few steps. `node_modules/rack42u/docs/concepts.md` explains each part of a rack.

## The workflow of an app

1. **Add rack42u** in the app's directory, once its `package.json` exists, through git at a tag or a commit: `bun add git+ssh://git@github.com/DreamZora/rack42u.git#<tag> valibot`. In a directory without a `package.json`, `bun add` changes the nearest one above it, another project's, without a warning. Once rack42u is installed, `node_modules/rack42u/docs/getting-started.md#add-rack42u` says more.
2. **Define the connectors** between the devices, with a schema for every input, output, and event: `node_modules/rack42u/docs/guides/connectors.md`.
3. **Write the devices**, one file each, which provide some connectors and need others: `node_modules/rack42u/docs/guides/devices.md`.
4. **Mount them in a rack**, in a manifest, `rack.ts` by default: by hand in slots, or scanned from directories: `node_modules/rack42u/docs/guides/racks.md`.
5. **Test each device on the bench**, with a stub for each of its needs: `node_modules/rack42u/docs/guides/testing.md`.
6. **Run the rack** with `rack dev` while you work, which replaces the devices whose files change, and with `rack start` otherwise: `node_modules/rack42u/docs/guides/running.md`.
7. **Look at what it reports**: `status()`, `metrics()`, `history()`, and the log, also through `rack ctl`: `node_modules/rack42u/docs/guides/managing.md` and `node_modules/rack42u/docs/reference/reports.md`.

## Rules that keep devices swappable

- A device never imports another device, and never holds another device's objects. It calls the ports it needs, through `ctx.ports`, and the rack wires them: `node_modules/rack42u/docs/guides/devices.md#the-context`.
- A device may need only devices in lower slots: the rack starts devices from the bottom up and stops them from the top down. A lower device tells an upper one about changes with events: `node_modules/rack42u/docs/concepts.md#the-gravity-rule`.
- Data between devices must survive `structuredClone`: no functions, and class instances arrive as plain objects. Errors cross as `RackError` codes: `node_modules/rack42u/docs/guides/devices.md#data-and-errors`.
- Background work, such as timers and work loops, starts in `activate` and stops in `deactivate`, not in `powerOn`, since during a swap the old and the new instance briefly run side by side: `node_modules/rack42u/docs/guides/devices.md#hooks`.
- In-memory state reaches a new instance only through `snapshot` and `restore`, and only in a swap; a crash or a restart starts the device without it. Keep state that matters in a storage device: `node_modules/rack42u/docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts` and `node_modules/rack42u/docs/guides/faults.md#crashes`.
- A device that must never run twice at once, such as one that holds a file or a lock, declares `swap: "cold"`: `node_modules/rack42u/docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts`.
- Device files import the framework as `rack42u` and `rack42u/std`, tests as `rack42u/bench` too, and the app declares its dependencies in its `package.json`, so that firmware keeps them outside the bundle: `node_modules/rack42u/docs/concepts.md#firmware`.

## Pitfalls

- **A call to an RPC member without input** still passes its input: `ctx.ports.notes.list(undefined)`. The context's port functions take the input first: `node_modules/rack42u/docs/guides/devices.md#the-context`.
- **Several providers of one connector below a need** fail the rack's start. A manifest placed by hand picks one with a patch, and a scanned rack with `use`: `node_modules/rack42u/docs/guides/racks.md#placing-devices-by-hand` and `node_modules/rack42u/docs/guides/racks.md#shared-instances-and-own-copies`.
- **Every file in a scanned directory** must default-export a device; helpers go in files or folders whose names start with `_`: `node_modules/rack42u/docs/guides/racks.md#scanned-racks`.
- **A scanned rack under `rack start`** follows its plan file, and refuses to start when the plan no longer fits; `rack plan --write` updates it: `node_modules/rack42u/docs/guides/racks.md#the-plan-file`.
- **An event emitted before an instance is installed is dropped**, such as one from `powerOn` during a swap: `node_modules/rack42u/docs/guides/testing.md#members-of-a-bench`.
- **`ctx.serve()` works in `powerOn` only**, and the listener binds once the instance goes into service: `node_modules/rack42u/docs/guides/listeners.md#swaps-and-faults`.
- **A response body of 15 KiB or more**, from a listener's handler that answers after an `await`, goes out faster and with its `Content-Length` through `wholeResponse()`: `node_modules/rack42u/docs/guides/listeners.md#bodies-in-memory`.
- **Listeners and the HTTP panel listen on `127.0.0.1`** unless their `hostname` says otherwise: `node_modules/rack42u/docs/guides/listeners.md#opening-a-listener` and `node_modules/rack42u/docs/guides/http.md#configuration`.
- **A hot swap of the device behind the HTTP panel keeps its WebSockets open**, but the new instance knows them only when the old one hands them over, with `handler.list()` in `snapshot` and `handler.restore()` in `restore`; otherwise their next message closes them: `node_modules/rack42u/docs/guides/http.md#websocket`.
- **Every call times out**, after 30 s by default, and every queue between devices is bounded; work beyond a bound fails with `RACK_OVERLOADED`: `node_modules/rack42u/docs/reference/limits.md`.
- **A device's own error codes** must not start with `RACK_`, except `RACK_OVERLOADED` for a limit of its own: `node_modules/rack42u/docs/guides/devices.md#data-and-errors`.
- **Each Worker gets a copy of `process.env`** as it is when the Worker starts: `node_modules/rack42u/docs/guides/devices.md#the-environment`.

## Where to look

| Question | Document |
|---|---|
| What does each part of a rack do? | `node_modules/rack42u/docs/concepts.md` |
| Why does rack42u work this way? | `node_modules/rack42u/docs/design.md` |
| How do I write a device, its hooks, its state, its background work? | `node_modules/rack42u/docs/guides/devices.md` |
| How do I move large binary data, or stream bytes? | `node_modules/rack42u/docs/guides/data.md` |
| How does a device serve HTTP or WebSocket itself? | `node_modules/rack42u/docs/guides/listeners.md` |
| How do I route HTTP and WebSocket to devices? | `node_modules/rack42u/docs/guides/http.md` |
| How do I store data? | `node_modules/rack42u/docs/guides/storage.md` |
| What happens when a device crashes, hangs, or falls behind? | `node_modules/rack42u/docs/guides/faults.md` |
| How do swaps, reloads, fallback, and rollback work? | `node_modules/rack42u/docs/guides/updates.md` |
| Which exports, options, and types are there? | `node_modules/rack42u/docs/reference/api.md` |
| Which commands, flags, and environment variables does `rack` take? | `node_modules/rack42u/docs/reference/cli.md` |
| What does an error code mean? | `node_modules/rack42u/docs/reference/errors.md` |
| What are the bounds, timeouts, and defaults? | `node_modules/rack42u/docs/reference/limits.md` |
