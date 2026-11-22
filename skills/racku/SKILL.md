---
name: racku
description: Build, test, and change apps on racku, the Bun framework whose apps are hot-swappable devices mounted in a rack. Use when an app depends on racku, to write connectors, devices, or rack manifests, to test a device on the bench, to run a rack with `rack start` or `rack dev`, or to read what a running rack reports.
---

# racku

An app on racku is made of **devices**: modules of one file each, which the **rack**, one Bun process, runs in Workers of their own. Devices talk to each other only through the rack's **backplane**, by **connectors**, contracts with schemas, and the rack can replace any device while the others keep serving.

The documentation ships with the package, and this skill names each document by its path in the app's directory: `node_modules/racku/README.md`, and the map of the rest, `node_modules/racku/docs/README.md`. A `#` after a path names a section, by the anchor of its heading. Read `node_modules/racku/docs/getting-started.md` first: it builds a whole app in a few steps. `node_modules/racku/docs/concepts.md` explains each part of a rack.

## The workflow of an app

1. **Add racku** in the app's directory, once its `package.json` exists, from npm: `bun add racku valibot`. In a directory without a `package.json`, `bun add` changes the nearest one above it, another project's, without a warning. For a commit that isn't released yet, racku comes from its repository through git, at that commit. Once racku is installed, `node_modules/racku/docs/getting-started.md#add-racku` says more.
2. **Define the connectors** between the devices, with a schema for every input, output, and event: `node_modules/racku/docs/guides/connectors.md`.
3. **Write the devices**, one file each, which provide some connectors and need others: `node_modules/racku/docs/guides/devices.md`.
4. **Mount them in a rack**, in a manifest, `rack.ts` by default: by hand in slots, or scanned from directories: `node_modules/racku/docs/guides/racks.md`.
5. **Test each device on the bench**, with a stub for each of its needs: `node_modules/racku/docs/guides/testing.md`.
6. **Run the rack** with `rack dev` while you work, which replaces the devices whose files change, and with `rack start` otherwise: `node_modules/racku/docs/guides/running.md`.
7. **Look at what it reports**: `status()`, `metrics()`, `history()`, and the log, also through `rack ctl`: `node_modules/racku/docs/guides/managing.md` and `node_modules/racku/docs/reference/reports.md`.

## Rules that keep devices swappable

- A device never imports another device, and never holds another device's objects. It calls the ports it needs, through `ctx.ports`, and the rack wires them: `node_modules/racku/docs/guides/devices.md#the-context`.
- A device may need only devices in lower slots: the rack starts devices from the bottom up and stops them from the top down. A lower device tells an upper one about changes with events: `node_modules/racku/docs/concepts.md#the-gravity-rule`.
- Data between devices must survive `structuredClone`: no functions, and class instances arrive as plain objects. Errors cross as `RackError` codes: `node_modules/racku/docs/guides/devices.md#data-and-errors`.
- Background work, such as timers and work loops, starts in `activate` and stops in `deactivate`, not in `powerOn`, since during a swap the old and the new instance briefly run side by side: `node_modules/racku/docs/guides/devices.md#hooks`.
- In-memory state lives in the device file's module variables, which belong to one instance, since each instance runs in a Worker of its own: `node_modules/racku/docs/guides/devices.md#a-device-file`. It reaches a new instance only through `snapshot` and `restore`, and only in a swap; a crash or a restart starts the device without it. Keep state that matters in a storage device: `node_modules/racku/docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts` and `node_modules/racku/docs/guides/faults.md#crashes`.
- A device that must never run twice at once, such as one that holds a file or a lock, declares `swap: "cold"`: `node_modules/racku/docs/guides/updates.md#hot-swaps-cold-swaps-and-restarts`.
- Device files import the framework as `racku` and `racku/std`, tests as `racku/bench` too, and the app declares its dependencies in its `package.json`, so that firmware keeps them outside the bundle: `node_modules/racku/docs/concepts.md#firmware`.
- Plugins of an app are devices in a hot-plug directory, which start on their own and come and go with their files. A host reaches them with `every(connector)`, calls the extension points that they provide, and discovers their own calls through `commands/v1`; nothing registers by a call: `node_modules/racku/docs/guides/hotplug.md`.

## Pitfalls

- **A call to an RPC member without input** still passes its input: `ctx.ports.notes.list(undefined)`. The context's port functions take the input first: `node_modules/racku/docs/guides/devices.md#the-context`.
- **Several providers of one connector below a need** fail the rack's start. A manifest placed by hand picks one with a patch, and a scanned rack with `use`: `node_modules/racku/docs/guides/racks.md#placing-devices-by-hand` and `node_modules/racku/docs/guides/racks.md#shared-instances-and-own-copies`.
- **`bun run rack …` runs `rack.ts`**, the manifest, rather than the `rack` command, and prints nothing. Run the command through the scripts of `package.json`, such as `bun run start`: `node_modules/racku/docs/guides/running.md#running-a-rack-from-another-program`.
- **Every file in a scanned directory** must default-export a device; helpers go in files or folders whose names start with `_`: `node_modules/racku/docs/guides/racks.md#scanned-racks`.
- **A scanned rack under `rack start`** follows its plan file, and refuses to start when the plan no longer fits; `rack plan --write` updates it: `node_modules/racku/docs/guides/racks.md#the-plan-file`.
- **A rack whose devices follow a data file**, such as one device for each entry of a list, runs from a program of the app's own, which calls `reload(manifest)` when the file changes: `rack start` and `rack dev` don't read the manifest again when a file it reads changes: `node_modules/racku/docs/guides/running.md#a-layout-that-follows-data`.
- **An event emitted before an instance is installed is dropped**, such as one from `powerOn` during a swap: `node_modules/racku/docs/guides/testing.md#members-of-a-bench`.
- **`ctx.serve()` works in `powerOn` only**, and the listener binds once the instance goes into service: `node_modules/racku/docs/guides/listeners.md#swaps-and-faults`.
- **A response body of 15 KiB or more**, from a listener's handler that answers after an `await`, goes out faster and with its `Content-Length` through `wholeResponse()`: `node_modules/racku/docs/guides/listeners.md#bodies-in-memory`.
- **A large file** goes out with its `Content-Length`, from disk, through `fileResponse()`, also through the HTTP panel, where a body in memory of 1 MiB or more, and any stream, goes out chunked: `node_modules/racku/docs/guides/listeners.md#files` and `node_modules/racku/docs/guides/http.md#requests`.
- **Listeners and the HTTP panel listen on `127.0.0.1`** unless their `hostname` says otherwise: `node_modules/racku/docs/guides/listeners.md#opening-a-listener` and `node_modules/racku/docs/guides/http.md#configuration`.
- **Any web page can send requests to `127.0.0.1`**, and browsers apply no CORS to WebSockets, so a device that answers HTTP, through the HTTP panel or a listener of its own, checks the `Origin` of WebSocket upgrades and of requests that change state: `node_modules/racku/docs/guides/http.md#websocket` and `node_modules/racku/docs/guides/listeners.md#opening-a-listener`.
- **A hot swap of the device behind the HTTP panel keeps its WebSockets open**, but the new instance knows them only when the old one hands them over, with `handler.list()` in `snapshot` and `handler.restore()` in `restore`; otherwise their next message closes them: `node_modules/racku/docs/guides/http.md#websocket`.
- **Every call times out**, after 30 s by default, and every queue between devices is bounded; work beyond a bound fails with `RACK_OVERLOADED`: `node_modules/racku/docs/reference/limits.md`.
- **A device's own error codes** must not start with `RACK_`, except `RACK_OVERLOADED` for a limit of its own: `node_modules/racku/docs/guides/devices.md#data-and-errors`.
- **Each Worker gets a copy of `process.env`** as it is when the Worker starts: `node_modules/racku/docs/guides/devices.md#the-environment`.

## Where to look

| Question | Document |
|---|---|
| What does each part of a rack do? | `node_modules/racku/docs/concepts.md` |
| Why does racku work this way? | `node_modules/racku/docs/design.md` |
| How do I write a device, its hooks, its state, its background work? | `node_modules/racku/docs/guides/devices.md` |
| How do I move large binary data, or stream bytes? | `node_modules/racku/docs/guides/data.md` |
| How does a device serve HTTP or WebSocket itself? | `node_modules/racku/docs/guides/listeners.md` |
| How do I route HTTP and WebSocket to devices? | `node_modules/racku/docs/guides/http.md` |
| How do I store data? | `node_modules/racku/docs/guides/storage.md` |
| What happens when a device crashes, hangs, or falls behind? | `node_modules/racku/docs/guides/faults.md` |
| How do swaps, reloads, fallback, and rollback work? | `node_modules/racku/docs/guides/updates.md` |
| How do a running rack's devices follow data, such as one per entry of a file? | `node_modules/racku/docs/guides/running.md#a-layout-that-follows-data` |
| How do I ship the app as one executable, and replace a device in it with a file? | `node_modules/racku/docs/guides/running.md#a-rack-in-one-executable` |
| Which exports, options, and types are there? | `node_modules/racku/docs/reference/api.md` |
| Which commands, flags, and environment variables does `rack` take? | `node_modules/racku/docs/reference/cli.md` |
| What does an error code mean? | `node_modules/racku/docs/reference/errors.md` |
| What are the bounds, timeouts, and defaults? | `node_modules/racku/docs/reference/limits.md` |
