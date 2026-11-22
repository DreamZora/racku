# API

rack42u has three entry points: `rack42u`, `rack42u/std`, and `rack42u/bench`. This page lists every export of each, in a table per topic, with links to the guides that show how to use them. Every export also has a JSDoc comment in the source, with its parameters, its return value, its errors, and when it may be called, which editors show.

## rack42u

The rack runtime: connectors, devices, manifests, starting a rack, and its handle.

### Connectors

| Export | Kind | What it is |
|---|---|---|
| `connector(id, members)` | function | Defines a connector: its id, `<name>/v<major>`, and its members. See [Connectors](../guides/connectors.md). |
| `rpc(input, output)` | function | Declares an RPC member, with the schemas of its input and its output. |
| `event(payload)` | function | Declares an event member, with the schema of its payload. |
| `stream()` | function | A schema for a byte stream in the input or the output of an RPC member: a `ReadableStream` of `Uint8Array` chunks. See [Streams](../guides/data.md#streams). |
| `Connector` | type | A connector, as `connector()` returns it. |
| `ConnectorInfo` | type | The description of a connector that a device reports when it loads: its id, and the kind of each member. |
| `Members` | type | The members of a connector, by name. |
| `MemberSpec` | type | One member of a connector: an `RpcSpec` or an `EventSpec`. |
| `RpcSpec` | type | An RPC member. The provider validates its input before the handler runs, and its output before the result goes back. |
| `EventSpec` | type | An event member. The publisher validates its payload before it is delivered. |
| `RpcInput` | type | The input type of an RPC member, as a caller passes it. |
| `RpcParsedInput` | type | The input type of an RPC member, as the provider sees it after validation. |
| `RpcOutput` | type | The result type of an RPC member, as the caller receives it. |
| `RpcReturn` | type | The result type that an RPC handler returns, before validation. |
| `EventInput` | type | The payload type that a publisher passes, before validation. |
| `EventPayload` | type | The payload type of an event, as subscribers receive it. |

### Devices

| Export | Kind | What it is |
|---|---|---|
| `device(spec)` | function | Defines a device, the default export of a device file. See [Devices](../guides/devices.md). |
| `own(connector)` | function | A need that gets a copy of its provider, serving only this consumer. See [Shared instances and own copies](../guides/racks.md#shared-instances-and-own-copies). |
| `patched(connector, address)` | function | A need wired to the port at a `<device>.<port>` address. See [Needs from configuration](../guides/devices.md#needs-from-configuration). |
| `every(connector)` | function | A need for every device below that provides the connector, by name. |
| `isOwn(need)` | function | Whether a need was made by `own()`. |
| `isPatched(need)` | function | Whether a need was made by `patched()`. |
| `isEvery(need)` | function | Whether a need was made by `every()`. |
| `DeviceSpec` | type | What a device file passes to `device()`: its model, height, priority, needs, provides, configuration schema, swap mode, and hooks. |
| `DeviceDefinition` | type | A device, as `device()` returns it. |
| `DeviceContext` | type | `ctx`, the first argument of every hook: ports, events, `serve()`, configuration, log, signal, slot, firmware, and base directory. See [The context](../guides/devices.md#the-context). |
| `ActivateScope` | type | `scope`, the second argument of `activate`: timers, a signal, and watchdogs that stop on `deactivate`. See [Background work](../guides/devices.md#background-work). |
| `CallContext` | type | `call`, the second argument of an RPC implementation: its signal, its deadline, and `transfer()` for its result. |
| `CallOptions` | type | The options of an outgoing call: `timeout`, `streamTimeout`, `signal`, and `transfer`. |
| `ConfigOf` | type | The configuration type that a device sees for its configuration schema. |
| `DeviceLog` | type | `ctx.log`: `debug`, `info`, `warn`, and `error`, which reach the rack's log. |
| `LogLevel` | type | `"debug"`, `"info"`, `"warn"`, or `"error"`. |
| `Need` | type | One need: a connector, which shares its provider, an `own()` need, a `patched()` need, or an `every()` need. |
| `Needs` | type | A device's needs, by name. |
| `NeedConnector` | type | The connector that a need calls, whatever kind of need it is. |
| `Own` | type | A need made by `own()`. |
| `Patched` | type | A need made by `patched()`. |
| `Every` | type | A need made by `every()`. |
| `NoPorts` | type | The ports of a device that declares none. |
| `Ports` | type | Connectors by need or port name. |
| `PortClient` | type | `ctx.ports.<need>`: one function per RPC member of the needed connector. |
| `PortEvents` | type | `ctx.on.<need>`: one subscription function per event member of the needed connector. |
| `PortSet` | type | `ctx.ports.<need>` of an every need: `list()`, `get(name)`, and `changed(handler)`. |
| `ReachedDevice` | type | One device that an every need reaches: its `name`, `model`, `firmware`, and `hotplug`. |
| `EveryEvents` | type | `ctx.on.<need>` of an every need, whose handlers also get the name of the device that emitted the event. |
| `PortEmitter` | type | `ctx.emit.<port>`: one publishing function per event member of the provided connector. |
| `PortImpl` | type | The implementation of one provided port: one function per RPC member. |
| `PortImpls` | type | The implementations of every provided port, as `powerOn` returns them. |
| `Watchdog` | type | A watchdog that `scope.watchdog()` arms, with `feed()` and `cancel()`. See [Hangs and watchdogs](../guides/faults.md#hangs-and-watchdogs). |

### Errors

| Export | Kind | What it is |
|---|---|---|
| `RackError` | class | An error with a stable code and optional data that can be cloned, which keeps both across the backplane. See [Error codes](errors.md). |
| `isRackError(value)` | function | Whether a value is a `RackError`. |
| `RackErrorCode` | type | The rack's own codes, which start with `RACK_`. |
| `WireError` | type | An error as it travels between threads: its code, message, and data. |

### Listeners

| Export | Kind | What it is |
|---|---|---|
| `wholeResponse(request, body, init?)` | function | A `Response` for a body in memory, in the form that Bun sends in one write, with its `Content-Length`. See [Bodies in memory](../guides/listeners.md#bodies-in-memory). |
| `fileResponse(file, init?)` | function | A `Response` for a file, which Bun sends from disk with its `Content-Length`, from a listener or through the HTTP panel. See [Files](../guides/listeners.md#files). |
| `ServeOptions` | type | The options of `ctx.serve()`: those of `Bun.serve` that a device needs, and `allowedHosts`. See [Listeners](../guides/listeners.md). |
| `Listener` | type | A listener, as `ctx.serve()` resolves with it and as its handlers receive it, with `url`, `hostname`, `port`, `upgrade()`, `timeout()`, `requestIP()`, `reload()`, `setTls()`, and `publish()`. |
| `ListenerHandlers` | type | The handlers of a listener: `fetch`, `routes`, `error`, and `websocket`, which `reload()` replaces. |
| `ListenerHandler` | type | A handler of a listener's requests. |
| `ListenerRoute` | type | What a route answers with: a handler, a `Response`, or one of those per method. |
| `ListenerRouteHandler` | type | A handler of a route, which gets the route's parameters as `request.params`. |
| `ListenerMethod` | type | An HTTP method that a route may give a handler of its own. |
| `ListenerTls` | type | A certificate and its key, in PEM, for a listener. |
| `ListenerWebSocket` | type | The WebSocket handlers and limits of a listener. |

### Manifests

| Export | Kind | What it is |
|---|---|---|
| `rack(name, spec)` | function | Declares a rack manifest, the default export of a manifest file. See [Racks](../guides/racks.md). |
| `slot(source, options?)` | function | Describes a device to mount: its file, and its name and configuration. |
| `RackManifest` | type | A validated manifest, as `rack()` returns it. |
| `RackSpec` | type | What a manifest passes to `rack()`: a `PlacedRackSpec` or a `ScannedRackSpec`. |
| `PlacedRackSpec` | type | A rack whose devices are placed in slots by hand, with its `size`, its `slots`, and its `patch` list. |
| `ScannedRackSpec` | type | A rack whose devices are scanned from directories, and placed by its plan. |
| `ScanSpec` | type | How a scanned rack finds and plans its devices: `devices`, `roots`, `use`, and `config`. |
| `SlotSpec` | type | A device to mount, as `slot()` and the factories of `rack42u/std` return it. |
| `SlotOptions` | type | The options of `slot()`: `name` and `config`. |

### start()

`start(manifest, options?)` starts a rack from its manifest, and resolves with the rack's handle once every device is online. Its options, the type `StartOptions`:

| `start` option | Default | Meaning |
|---|---|---|
| `baseDir` | working directory | Where relative paths resolve and `.rack/` is written. It lies inside the app, below the `node_modules` that holds rack42u: firmware in `.rack/firmware/` imports rack42u and the app's packages from there, and one outside the app fails to load with `RACK_MANIFEST`. |
| `logger` | one line per entry on the console | Receives every log entry. |
| `callTimeout` | 30 000 ms | Timeout of calls that set none. |
| `hookTimeout` | 30 000 ms | Timeout of boot, each lifecycle hook, and each `metrics()` request. |
| `drainTimeout` | 10 000 ms | How long a retiring instance may finish its calls. |
| `probation` | 60 000 ms | How long a new instance may crash before it falls back to known-good firmware; 0 turns fallback off. |
| `historyLimit` | 256 | Most update records `history()` keeps. |
| `watchdog` | 10 000 ms | Timeout of every device's event-loop watchdog, at least 1 000; 0 turns off every watchdog. See [Hangs and watchdogs](../guides/faults.md#hangs-and-watchdogs). |
| `queueLimit` | 10 000 | Most calls a need has unfinished, and most events that wait for one subscriber. See [Overload](../guides/faults.md#overload). |
| `control` | off | Open the management endpoint: `true` for the platform's default, or `{ port, token? }` for loopback TCP. |
| `plan` | `true` | How a scanned rack uses its plan file: `true` follows it, `"update"` rewrites it as `rack dev` does, and `false` neither reads nor writes it. |
| `faultInjection` | `false` | Let `injectFault()` make devices crash or hang on purpose, for tests. See [Crashes and hangs](../guides/testing.md#crashes-and-hangs). |

| Export | Kind | What it is |
|---|---|---|
| `start(manifest, options?)` | function | Starts a rack: builds the firmware, boots and checks every device, and powers them on from the bottom up. |
| `StartOptions` | type | The options above. |

### The rack handle

`start()` resolves with a `RackHandle`, whose methods are these. `status()`, `history()`, and `subscribe()` answer at once, and the others return promises:

| Method | Returns | Purpose |
|---|---|---|
| `status()` | `SlotStatus[]` | Each device's slot, height, state, firmware and known-good hashes, probation, calls in flight, recent crashes, watchdogs, stuck threads, and, for a copy, its `owner`. |
| `call(address, method, input, options?)` | `Promise<unknown>` | Call a port from outside the rack; the promise resolves with the member's output. |
| `swap(name, source?)` | `Promise<void>` | Replace a device now: with a new build of its own file, even when that hasn't changed, or, in a rack placed by hand, with another device file, a path relative to the base directory. The promise resolves once the new instance serves. When the swap fails, it rejects, and the device keeps its old firmware. |
| `restart(name, { cascade? })` | `Promise<ReloadResult[]>` | Stop a device and start it again from scratch; its direct consumers then reload. |
| `reload(manifest?)` | `Promise<ReloadResult[]>` | Rebuild all firmware and replace the devices whose hash changed; with a manifest, also move to its layout. |
| `rollback(name, { to? })` | `Promise<ReloadResult[]>` | Go back to earlier firmware that the history keeps. |
| `history(name?)` | `UpdateRecord[]` | List the updates, newest first. |
| `plug(u, slot(...))` / `unplug(name)` | `Promise<void>` | Add a device to a free slot, or remove one that nothing uses. |
| `subscribe(listener)` | `() => void` | Receive power, swap, fault, and log events, until the function it returns is called. |
| `metrics()` | `Promise<RackMetrics>` | Read each device's call and event counters, and the rack's counters of calls from outside the rack. |
| `injectFault(name, kind)` | `Promise<void>` | Make a device crash, `"crash"`, or hang, `"hang"`, on purpose, for a test, in a rack started with `faultInjection`. See [Crashes and hangs](../guides/testing.md#crashes-and-hangs). |
| `stop()` | `Promise<void>` | Shut down from the top down. |

The types of what the methods take and return:

| Export | Kind | What it is |
|---|---|---|
| `RackHandle` | type | A running rack, with the methods above. |
| `SlotStatus` | type | One device, as `status()` reports it. See [Reports](reports.md#status). |
| `SlotState` | type | The state of a slot: `"online"`, `"swapping"`, `"degraded"`, `"resetting"`, or `"faulted"`. |
| `StuckThread` | type | A thread of an ended instance that is still stuck in native code, with its firmware and since when. |
| `WatchdogStatus` | type | A watchdog of an instance, as `status()` reports it: its name, timeout, and last feed. |
| `ListenerState` | type | A listener of an instance, as `status()` reports it: its URL, certificates, requests in flight, and open WebSockets. |
| `CertificateInfo` | type | A certificate of a listener, as `status()` reports it: its subject, server name, and expiry. |
| `RackEvent` | type | What `subscribe()` delivers: a `power`, `swap`, `fault`, or `log` event. |
| `ReloadResult` | type | One device that `reload()` or `restart()` tried to replace, with its old and new firmware, its mode, and its error. |
| `ReloadMode` | type | How a device was replaced: `"hot"`, `"cold"`, `"restart"`, `"plug"`, or `"unplug"`. |
| `RestartOptions` | type | The options of `restart()`: `cascade`. |
| `RollbackOptions` | type | The options of `rollback()`: `to`. |
| `SwapAction` | type | What a management operation did to a device: `"plug"`, `"unplug"`, or `"swap"`. |
| `UpdateRecord` | type | One update of a device, as `history()` lists it. See [Reports](reports.md#history). |
| `UpdateCause` | type | What asked for an update: `"reload"`, `"swap"`, `"restart"`, `"rollback"`, `"fallback"`, `"plug"`, or `"unplug"`. |

### Metrics

| Export | Kind | What it is |
|---|---|---|
| `RackMetrics` | type | What `metrics()` resolves with: `devices` and `outside`. See [Reports](reports.md#metrics). |
| `DeviceMetrics` | type | The counters of one device's installed instance. |
| `PortMetrics` | type | The counters of a provided port, by member. |
| `NeedMetrics` | type | The counters of a need, by member. |
| `ServedRpcMetrics` | type | The counters of one RPC member of a provided port: the calls the device served. |
| `CalledRpcMetrics` | type | The counters of one RPC member of a need: the calls the device made. |
| `EmittedEventMetrics` | type | The counters of one event member of a provided port: `emitted` and `dropped`. |
| `ReceivedEventMetrics` | type | The counters of one event member of a need: `received`. |
| `StreamMetrics` | type | The counters of the byte streams that one RPC member's calls carried. |
| `LoopMetrics` | type | The delay of a device's event loop: `delayMs` and `maxDelayMs`. |
| `OutsideMetrics` | type | The counters of the calls from outside the rack, which the main thread keeps. |

### Logs

| Export | Kind | What it is |
|---|---|---|
| `LogEntry` | type | One entry of the log: its time, level, message, data, and the device that wrote it, if one did. See [Reports](reports.md#the-log). |
| `Logger` | type | A function that receives every log entry of a rack, as the `logger` option of `start()`. |

### Schemas

| Export | Kind | What it is |
|---|---|---|
| `StandardSchemaV1` | type | The Standard Schema interface, which the schemas of connectors and configurations implement, as valibot's and zod's do. |

## rack42u/std

The standard connectors, and the factories that mount the standard devices. See [Storage devices](../guides/storage.md) and [The HTTP panel](../guides/http.md).

### Standard connectors

| Export | Kind | What it is |
|---|---|---|
| `Kv` | constant | `kv/v1`, a store of string keys and string values: `get`, `set`, `delete`, `keys`, and the event `changed`. |
| `Sql` | constant | `sql/v1`, a SQL database: `query`, `run`, and `batch`. |
| `Http` | constant | `http/v2`, which the HTTP panel calls: `handle` for each request, `opened`, `message`, and `closed` for each WebSocket, `sockets`, and the events `send` and `close`. See [The http/v2 connector](../guides/http.md#the-httpv2-connector). |

### Standard devices

| Export | Kind | What it is |
|---|---|---|
| `memkv(options?)` | function | Mounts `memkv`, an in-memory `kv/v1` store whose entries move to the new instance in a swap. |
| `sqlite(config, options?)` | function | Mounts `sqlite`, a `sql/v1` database on `bun:sqlite`. |
| `httpPanel(config, options?)` | function | Mounts `http-panel`, the standard HTTP panel. |
| `StdDeviceOptions` | type | The options of every factory: `name`, to rename the device. |
| `SqliteConfig` | type | The configuration of `sqlite`: `path`, a file relative to the base directory, or `":memory:"`. |
| `HttpPanelConfig` | type | The configuration of `http-panel`, as [Configuration](../guides/http.md#configuration) lists it. |
| `HttpPanelPair` | type | A certificate and its key for the HTTP panel: paths of PEM files, relative to the base directory. |

### HTTP handlers

| Export | Kind | What it is |
|---|---|---|
| `httpHandler(handlers, emit?)` | function | Implements `http/v2` with a fetch-style function, or with `fetch` and `websocket` handlers and the port's emitter. See [Mounting the panel](../guides/http.md#mounting-the-panel). |
| `FetchHandler` | type | A fetch-style function from `Request` to `Response`, such as the `fetch` of a routing library. |
| `HttpHandlers` | type | The handlers that `httpHandler()` adapts: `fetch`, `websocket`, and `streamThreshold`. |
| `HttpHandler` | type | An implementation of `http/v2`, as `httpHandler()` returns it, with `list()` and `restore()` for the sockets it knows. |
| `HttpServer` | type | What `fetch` gets beside the request, as Bun's `Server`: `upgrade()`. |
| `HttpSocket` | type | A WebSocket that a panel holds for the device: its `id`, its `data`, `send()`, and `close()`. |
| `HttpSocketState` | type | A socket and its data, as `list()` returns them and `restore()` takes them. |

## rack42u/bench

The test bench, which runs one device in a rack of its own. See [Testing a device](../guides/testing.md).

### The bench

| Export | Kind | What it is |
|---|---|---|
| `bench(source, options)` | function | Builds a device file into firmware and runs it in a rack of its own, with a stub below it for each of its needs, and a probe above it that records its events. |
| `stub(connector, implementation)` | function | Makes a stand-in for one need of a device on a bench. |
| `Bench` | type | A device running on a bench, as `bench()` resolves with it. |
| `BenchOptions` | type | The options of `bench()`: `needs`, `config`, `name`, and those of `start()`. |
| `BenchEvent` | type | An event that the device on a bench emitted. |
| `BenchFault` | type | A fault of the device on a bench: a crash, or a watchdog bite. |
| `Stub` | type | A stand-in for one need, as `stub()` returns it, with its `calls`, `dropped`, and `emit`. |
| `StubCall` | type | One call that a stub received: its member, its input, and when. |

### Device files of the bench

The bench writes a device file for each stub and for its probe, which import these. A test doesn't call them.

| Export | Kind | What it is |
|---|---|---|
| `stubDevice(spec)` | function | Defines the device that stands in for one need, and passes each call to the test. |
| `probeDevice(spec)` | function | Defines the device above the device on a bench, which passes every event it receives to the test. |
| `StubDeviceSpec` | type | What a stub's device file passes to `stubDevice()`. |
| `ProbeDeviceSpec` | type | What a probe's device file passes to `probeDevice()`. |
