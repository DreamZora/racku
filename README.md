# rack42u

rack42u is a Bun framework for building an application out of hot-swappable **devices** mounted in a 42U-style **rack**. Each device runs in its own Worker, talks to other devices only through the rack's **backplane**, and can be replaced, reloaded, plugged in, or unplugged while the rack keeps running.

The framework provides the rack runtime and a few standard devices. What you mount in the rack, and whether the result is an API server, a worker process, or something else, is up to you.

> **Status: P3.** P3 adds byte streams in calls, listeners that devices open and that the rack hands over across swaps, and the HTTP panel as a standard device, with WebSocket, streaming bodies, and certificates that change without a restart. P2 added watchdogs for hung devices, stops that wait for a device's thread to end, and bounds on every backlog between devices. P1 added scanned racks, cold swaps and restarts, update safety, and `rack ctl` to P0, the first usable version. See [Not supported yet](#not-supported-yet) for what is still missing.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later. rack42u runs only on Bun; it is published as TypeScript source.
- Linux, macOS, or Windows on x64. [Windows](#windows) lists what differs there.

## Try the example

The repository contains an example app, [`examples/shop-api`](examples/shop-api): a SQLite database at the bottom of the rack, an in-memory cache above it, an orders API above that, and on top the HTTP panel, which passes requests for `/api/*` to the orders API.

```sh
bun install
bun src/cli.ts start examples/shop-api/rack.ts   # PORT=4000 to change the port
```

```sh
curl -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"item":"book","quantity":2,"price":12.5}'
# {"id":1,"item":"book","quantity":2,"price":12.5}

curl localhost:3000/api/orders/1     # served from the cache: "cached":true
curl localhost:3000/api/orders       # {"currency":"USD","orders":[...]}
curl localhost:3000/api/stats        # {"served":4,"firmware":"..."}
```

Press Ctrl-C to stop: the rack powers devices off from the top down.

To see hot reload, start it with `dev` instead of `start`, then edit `examples/shop-api/devices/orders.ts`. The rack rebuilds every device, swaps only `orders`, and `/api/stats` keeps counting where it was, under a new firmware hash. The database and the cache are not touched.

```sh
bun src/cli.ts dev examples/shop-api/rack.ts
```

In an app that depends on `rack42u`, the package's `rack` command runs the same CLI: `rack start` and `rack dev`.

A second example, [`examples/net-tool`](examples/net-tool), is a desktop app: a TCP and UDP tool whose window, on Tauri 2 and Quasar, talks to a rack that holds the sockets. Its Tauri shell runs the rack as [another program](#running-a-rack) would, and its devices are tested on the [bench](#testing-a-device). Its README lists what it needs, such as Rust, and how to run it.

The sections below build a second small app, file by file. The test suite extracts these files from this README and runs them.

## Concepts

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
| Panel | A device that owns external connections, such as the standard [HTTP panel](#http-panel), and passes the work to other devices through the backplane. |
| Listener | An HTTP server, WebSocket included, that a device opens with `ctx.serve()`, and that the rack hands over when the device swaps. |
| Firmware | The hashed bundle a device file is built into; the hash is its version. |
| Swap | The one process behind replace, hot reload, plug, and unplug. |

The **gravity rule** holds the design together: a device may depend only on devices in lower slots. The rack powers devices on from the bottom up and off from the top down, so storage sits low and entry points sit high.

## Connectors

A connector lists RPC methods (`rpc(input, output)`) and events (`event(payload)`). Schemas can come from any library that implements [Standard Schema](https://standardschema.dev), such as valibot or zod.

```ts
// connectors.ts
import { connector, event, rpc } from "rack42u";
import * as v from "valibot";

export const Greeter = connector("acme.greeter/v1", {
  greet: rpc(v.object({ name: v.string() }), v.string()),
  greeted: event(v.object({ name: v.string() })),
});
```

The id has the form `<name>/v<major>`; change the major version for incompatible changes. The provider validates RPC input and output, and the publisher validates event payloads.

## Devices

A device file default-exports `device({...})`. `powerOn` returns the implementation of every port in `provides`.

```ts
// devices/greeter.ts
import { device } from "rack42u";
import { Kv } from "rack42u/std";
import * as v from "valibot";
import { Greeter } from "../connectors.ts";

let greetings = 0;

export default device({
  model: "greeter",
  needs: { cache: Kv },
  provides: { greeter: Greeter },
  config: v.object({ prefix: v.string() }),

  powerOn(ctx) {
    return {
      greeter: {
        async greet({ name }, call) {
          // call.signal aborts when the caller cancels or the call times out.
          await ctx.ports.cache.set({ key: "last", value: name }, { signal: call.signal });
          await ctx.emit.greeter.greeted({ name });
          greetings++;
          return `${ctx.config.prefix} ${name}`;
        },
      },
    };
  },

  // Background tasks start in activate and stop automatically on deactivate.
  activate(ctx, scope) {
    scope.every(60_000, () => ctx.log.info("greetings so far", { greetings }));
  },

  // In-memory state moves to the new instance during a swap or hot reload.
  snapshot: () => ({ greetings }),
  restore(ctx, state) {
    const parsed = v.safeParse(v.object({ greetings: v.number() }), state);
    if (parsed.success) greetings = parsed.output.greetings;
  },
});
```

Hooks run in this order: `powerOn` → `selfTest` → `activate` ⇄ `deactivate` → `powerOff`. All but `powerOn` are optional, and `powerOn` is optional too when a device provides nothing. Start timers and other background work in `activate`, not in `powerOn`: during a swap the old and the new instance briefly run side by side.

The first argument of every hook, `ctx`, provides:

| Member | Purpose |
|---|---|
| `ctx.ports.<need>.<method>(input, { timeout?, signal?, transfer?, streamTimeout? })` | Call a needed connector. |
| `ctx.on.<need>.<event>(handler)` | Subscribe to an event; returns an unsubscribe function. |
| `ctx.emit.<port>.<event>(payload)` | Publish an event on a provided port. |
| `ctx.serve(options)` | Open a listener, in `powerOn` only; see [Listeners](#listeners). |
| `ctx.config` | The configuration, validated by the `config` schema. |
| `ctx.log.debug/info/warn/error(message, data?)` | Log through the rack. |
| `ctx.signal` | Aborts after `powerOff`. |
| `ctx.slot`, `ctx.firmware`, `ctx.baseDir` | `{ name, u }`, the firmware hash, and the rack base directory. |

`activate` also receives `scope`. `scope.every(ms, task)` and `scope.after(ms, task)` schedule timers that stop on `deactivate`, and each returns a function that cancels its timer; `scope.signal` aborts on `deactivate`. Errors thrown by timer tasks and event handlers are logged; they do not crash the device. `scope.watchdog(ms, name?)` arms a watchdog for a work loop, as [Hangs and watchdogs](#hangs-and-watchdogs) describes.

Data that crosses the backplane must survive `structuredClone`: no functions, no class instances. It is copied, unless you move or share binary data as [Binary data](#binary-data) describes. Throw `new RackError(code, message, data?)` to give callers a code they can branch on. Device codes must not start with `RACK_`, except `RACK_OVERLOADED` for a limit of the device's own, as [Overload](#overload) describes. Any other exception reaches the caller as `RACK_DEVICE_FAULT`.

Each Worker receives a copy of `process.env` as it is when the Worker starts.

### Needs from configuration

`needs` can also be a function of the validated configuration, for a device whose configuration says what it depends on, such as a panel's routes. The rack calls it when the device boots. `patched(connector, address)` wires a need to the port at a `<device>.<port>` address:

```ts
// In a device file whose config is v.object({ stores: v.array(v.string()) }):
needs: (config) =>
  Object.fromEntries(config.stores.map((store) => [store, patched(Kv, `${store}.kv`)])),
```

- **Placed by hand:** a need that `patched()` wires acts as a patch to its address, and a patch in the manifest for the same need wins. Needs without `patched()` are wired as any need.
- **Scanned:** the address names a model, which the plan pulls in and wires the need to. A `use` entry keyed `<model>.<need>` wins, while one keyed by a connector id doesn't change the need. The plan computes the needs from the configuration of the model's shared instance: its entry in `config`, or else its spec's.
- **Failures:** a function that throws, or returns something that isn't needs, fails the device's configuration with `RACK_INVALID_CONFIG`.
- **Changes:** a reload with new configuration replaces the device, whose new instance gets the needs the function computes from it.

## Binary data

Calls and events copy their data from one Worker to the next. For large binary data, a device can move the data or share it instead.

**Moving** an `ArrayBuffer` hands its memory to the other side without a copy, and the devices stay fully isolated: the sender's buffer is detached, and every view on it becomes empty. A caller lists the buffers to move in the `transfer` option of the call. A provider passes the buffers of its result to `call.transfer`:

```ts
// In connectors.ts: bytes can move in both directions.
export const Gzip = connector("acme.gzip/v1", {
  compress: rpc(v.object({ bytes: v.instance(Uint8Array) }), v.instance(Uint8Array)),
});

// In the provider's powerOn:
return {
  gzip: {
    compress({ bytes }, call) {
      const packed = Bun.gzipSync(bytes);
      call.transfer(packed.buffer); // the result moves to the caller
      return packed;
    },
  },
};

// In a device that needs Gzip. The call takes data.buffer, so data is empty afterward.
const packed = await ctx.ports.gzip.compress({ bytes: data }, { transfer: [data.buffer] });
```

- **When buffers are taken:** a call takes the buffers in `transfer` as soon as it is made, whatever its outcome. This includes a call that waits while its provider is swapped. A caller therefore cannot retry with the same buffers.
- **Calls from outside the rack:** `rack.call` takes the same option.
- **Invalid lists:** the call fails with `RACK_INVALID_INPUT`, and nothing is detached, when an entry is not an attached `ArrayBuffer`, is a `SharedArrayBuffer`, or appears twice.
- **Results:** the buffers passed to `call.transfer` are gone once the result is sent, even when the call fails. Passing a `SharedArrayBuffer` fails the call with `RACK_INVALID_OUTPUT`.
- **Events:** an event is copied or shared, never moved, because it goes to every subscriber.

**Sharing** a `SharedArrayBuffer` gives every receiver the same memory, so nothing is copied. This works in the input or the result of a call, in an event, and with `rack.call`, and a typed array on a `SharedArrayBuffer` is shared too. Declare such a field with `v.instance(SharedArrayBuffer)`. The rack cannot see or order access to shared memory, so these rules are up to the devices:

- **A shared buffer belongs to the call that carries it.** The caller leaves it alone until the call succeeds. The provider neither keeps it nor uses it after returning.
- **Drop the buffer after a failed call.** After a call fails, times out, or is cancelled, do not reuse the buffer: the provider may still be running and writing to it.
- **Events are read-only.** A shared buffer in an event is read-only for the publisher and for every subscriber.
- **Do not keep a shared buffer as a channel.** Do not exchange data with another device through a kept buffer outside calls and events, such as a ring buffer or `Atomics.wait` and `Atomics.notify`. The backplane cannot hold or switch that traffic during a swap, and the new instance never gets the buffer. `Atomics.wait` also blocks the device's whole Worker.
- **Validate the bytes.** A schema checks that a buffer is there, not what it holds.

## Streams

A call can stream bytes instead of carrying them in one message, in its input, in its result, or both. In device code a stream is a standard `ReadableStream` of `Uint8Array` chunks, which a connector declares with `stream()`:

```ts
// In connectors.ts:
import { connector, rpc, stream } from "rack42u";
import * as v from "valibot";

export const Files = connector("acme.files/v1", {
  // Input: a name and the bytes to store. Output: the size and the bytes of a stored file.
  put: rpc(v.object({ name: v.string(), bytes: stream() }), v.number()),
  get: rpc(v.string(), v.object({ size: v.number(), bytes: stream() })),
});

// In a device that needs Files:
await ctx.ports.files.put({ name: "a.bin", bytes: Bun.file("a.bin").stream() });
const { bytes } = await ctx.ports.files.get("a.bin");
for await (const chunk of bytes) total += chunk.byteLength;
```

- **Where a stream goes:** a call carries at most one stream in its input and one in its output, as the value itself or as a top-level property of an object. The rack finds the stream by its value, so other schema libraries work too, such as zod's `z.instanceof(ReadableStream)`. A stream nested deeper, a second one, or one in an event payload can't be cloned, and fails as such a value does, with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
- **Flow control:** at most 256 KiB of a stream is in flight. The sending side reads its source only as fast as the reader takes chunks, so a slow reader slows the source. Each chunk is copied once and travels in pieces of at most 1 MiB, so the reader may get a large chunk as several pieces. A source keeps its buffers and may write into them again.
- **Timeouts:** a call whose input carries a stream times out from the end of that stream, so an upload doesn't time out while its bytes still move. Its provider sees `call.deadline` as `Infinity`. A stream fails with `RACK_TIMEOUT` at both ends when nothing moves on it for `streamTimeout`, a call option that defaults to the call's timeout.
- **Lifetimes:** a call takes its stream as soon as it is made, as it takes its `transfer` buffers. When the call fails before its provider reads the stream, the source is cancelled with `RACK_CANCELLED`. When a provider returns a result without a stream, the rest of its input is cancelled. When the result carries a stream, such as `input.pipeThrough(transform)`, the input stays open as long as that output stream.
- **Cancellation and errors:** a reader that cancels a stream cancels its source with `RACK_CANCELLED`, and the call's `signal` cancels its streams, also after the result has arrived. A source that fails errors the reader's stream with its error, after the pieces it sent before; a `RackError` keeps its code, and any other error becomes `RACK_DEVICE_FAULT`. A chunk that isn't a `Uint8Array` fails the stream at both ends with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
- **Swaps and faults:** the open streams of a device that is hot swapped go on until its old instance retires, at most `drainTimeout` after the switch, and then fail with `RACK_LINK_DOWN`. So a long-lived stream, such as server-sent events, doesn't hold a state handover. A cold swap or a restart cuts the streams once the calls have returned, with `RACK_LINK_DOWN`, and a crash or a watchdog bite fails them with `RACK_DEVICE_FAULT`.
- **Calls from outside the rack:** `rack.call` streams the same way, in both directions.
- **Counters:** in `rack.metrics()`, each RPC member whose calls carried streams gains `streams`, with `opened`, `open`, `bytesSent`, `bytesReceived`, and `errors` by code. `active` and `pending` count a call until its streams end, while `inFlight` in `status()` counts it until its result.
- **Limits:** the streams of a need are bounded by its unfinished calls, at most `queueLimit`, each with up to 256 KiB, or one piece of up to 1 MiB, in flight. With the defaults, that is about 2.4 GiB per need and direction, and up to 9.8 GiB in pieces of 1 MiB. Lower `queueLimit` for needs that can have many streams stalled at once.

## Listeners

A device can serve HTTP and WebSocket itself, on a listener that the rack hands over when the device swaps. It opens the listener with `ctx.serve()` in `powerOn`:

```ts
async powerOn(ctx) {
  const web = await ctx.serve({
    port: 8080, // 0 picks a free port, which the device keeps while the rack runs
    fetch: (request, listener) =>
      listener.upgrade(request) ? undefined : new Response("hello"),
    websocket: { message: (ws, data) => ws.send(data) },
  });
  ctx.log.info("serving", { url: web.url.href });
  return {};
},
```

The options are the ones of `Bun.serve` that a device needs: `fetch`, `routes`, `error`, `websocket`, `tls`, `hostname`, `port`, `maxRequestBodySize`, and `idleTimeout`, plus `allowedHosts`. The handlers receive the listener where `Bun.serve` passes its server; its `upgrade()`, `timeout()`, and `requestIP()` work as Bun's do.

| Option | Default | Beyond it |
|---|---|---|
| `hostname` | `127.0.0.1` | |
| `maxRequestBodySize` | 1 MiB | Bun answers 413. |
| `idleTimeout` | 10 s, from 1 to 255 | The connection closes. Bun applies it in steps of 4 s, and it also cuts a request whose whole exchange takes longer: traffic doesn't extend it. `listener.timeout(request, seconds)` extends it for one request. |
| `websocket.maxPayloadLength` | 1 MiB | The WebSocket closes with 1009. |
| `websocket.maxBuffered` | 1 MiB unsent | A WebSocket that has more unsent when the device sends to it closes with 1013. |
| `allowedHosts` | none | On a loopback `hostname`, a request whose `Host` header names any other host than the hostname, `localhost`, or these names gets 403, WebSocket upgrades included. |

- **When it listens:** `serve()` reserves the address, and the listener binds once the instance goes into service. Requests that arrive before the instance is installed wait for it, at most `queueLimit` per listener; beyond that they get 503. `ctx.serve()` works in `powerOn` only, and a `powerOn` in which a `serve()` rejected fails, even when the device caught it. An instance has at most 16 listeners.
- **Hot swaps:** the new instance binds the same address with `reusePort`, and only then does the old one stop listening, so requests keep being answered. Requests in flight on the old instance finish, and its WebSockets close with 1012, "service restart"; clients must reconnect. With a state handover, the requests that arrive during it wait for the new instance and see the restored state, and a response that still streams on the old instance doesn't hold the handover. A swap that fails leaves the old instance listening, and the requests that the new one held get 503.
- **Limits of a handover:** on Linux and Windows, a connection that the system queued for the old listener just as it stops can be reset. A request sent on an idle keep-alive connection as the old listener closes it can fail, unless its client retries it, as HTTP clients commonly do for idempotent methods.
- **Cold swaps and restarts:** nothing listens from the stop of the old instance to the end of the new one's `activate`, and connections are refused meanwhile. The new instance listens on the same port.
- **Unplugs and `stop()`** close the WebSockets with 1001, "going away".
- **Crashes and watchdog bites** end the instance's connections, and its requests in flight fail. The reset listens on the same port.
- **Port 0** keeps its port through swaps, restarts, resets, and fallbacks, until the device is unplugged or the rack stops.
- **Stuck threads:** a thread stuck in native code keeps the listeners it hadn't stopped. The system still accepts connections to them, and nothing answers. `status()` lists them with the stuck thread.
- **Conflicts:** two devices on one port fail with `RACK_HOOK_FAILED`, whatever their hostnames, and so does a port that another process holds, a second rack included. `data` names the `listener`, `<hostname>:<port>`, and its `holder`: the device, or `another process`, with the system's code in `cause`. On macOS, the check doesn't see another process that holds the port on another hostname, such as `0.0.0.0` against `127.0.0.1`. IPv6 was not measured.
- **Certificates:** `tls` takes `{ cert, key }`, such as `Bun.file()`s of PEM files, or a list of them with `serverName`, from which a client gets a certificate by its server name, and an unknown name the first. Certificates that don't load fail `powerOn`. `listener.setTls(tls)` replaces them while the rack runs: new connections get the new ones, and connections opened under the old ones keep working. Certificates that don't load are rejected with `RACK_INVALID_CONFIG`, and the old ones stay. A listener keeps at most two servers, so a further `setTls()` closes the WebSockets opened before the previous one with 1012.
- **Topics:** Bun's WebSocket topics belong to one server, so `ws.publish()` misses the WebSockets on a listener's other server after a `setTls()`. `listener.publish(topic, data)` reaches every server.
- **Other sockets:** a device may still open sockets with `Bun.listen`, `Bun.connect`, `Bun.udpSocket`, or `Bun.serve`. They close with its instance, and the rack neither sees them nor hands them over.
- **Bodies in memory:** when a handler answers after an `await`, Bun 1.4.4 writes the head of a body of 15 KiB or more in many small writes, several times slower than a smaller one. `wholeResponse(request, body, init?)` from `rack42u` builds the `Response` for a body of bytes or text in the form Bun sends in one write, with its `Content-Length` at every size, its answer to `HEAD` included, and the `Content-Type` Bun would give the body; use it in place of `new Response(body, init)`. A stream goes out chunked either way.

`status()` lists each listener of the installed instance under `listeners`: its `url`, its `certificates`, with `subject`, `serverName`, and `notAfter`, its `requests` in flight, and its open `webSockets`. The log reports `listening`, `listener handed over`, and `listener closed`, with `data.url`, and `certificates replaced` and `certificates rejected`.

## The rack manifest

A manifest names the device file in each slot. It never imports device code; the rack loads devices by path.

```ts
// rack.ts
import { rack, slot } from "rack42u";
import { httpPanel, memkv } from "rack42u/std";

export default rack("hello", {
  slots: {
    1: memkv(),
    3: slot("./devices/greeter.ts", { config: { prefix: "Hello," } }),
    4: slot("./devices/web.ts"),
    5: httpPanel({ port: 3000, routes: { "/greet": "web.http" } }),
  },
});
```

The `web` device is defined under [HTTP panel](#http-panel). The panel is a device too, above the devices it routes to.

- Relative device paths resolve against the rack base directory, which for `rack start` and `rack dev` is the manifest's directory.
- A device's name defaults to its model. Give devices that share a model distinct names with `slot(path, { name })`.
- Each need is wired to the only port with the same connector id among the devices below it. When there are several, add a patch: `patch: [["greeter.cache", "memkv.kv"]]`.
- The rack refuses to start when slots overlap, a device does not fit, two devices share a name, a need has no provider below it or more than one, or a patch names something that does not exist.

## Scanned racks

Instead of placing every device by hand, a manifest can name the directories that hold device files, and let the rack work out the instances, their wiring, and their slots:

```ts
// A scanned manifest: slots and patches are worked out from the device files.
import { rack } from "rack42u";
import { httpPanel, sqlite } from "rack42u/std";

export default rack("app", {
  devices: [
    "./devices",
    sqlite({ path: "data/app.db" }),
    httpPanel({ port: 3000, routes: { "/api/*": "a.http" } }),
  ],
  roots: ["http-panel", "b", "c"],
});
```

- **`devices`** lists directories and specs.
  - Every `.ts`, `.tsx`, `.js`, and `.mjs` file below a directory, at any depth, must default-export a device. Files and folders whose names start with `_` or `.` are skipped, and so is `node_modules`.
  - A `slot()` or standard-device spec adds one file, and its `config` becomes that model's default. A `name` in it defines a variant: the same file under another model name.
- **`roots`** names the models the rack starts on its own. Everything else starts only when something needs it, such as the models that a panel's routes name.

A need either shares its provider or owns a copy of it:

```ts
// In devices/a.ts: a owns a copy of d and a copy of f.
needs: { d: own(D), f: own(F) },
// In devices/c.ts: c shares e with every device that shares it, and owns a copy of f.
needs: { e: E, f: own(F) },
```

Each model has one shared instance, named after the model, and each `own` need gets a copy named `<consumer>-<need>`. With the roots `http-panel`, `b`, and `c`, the panel's route to `a`, and `b` needing `E` as well, the plan is:

| Slot | Instance | Serves |
|---|---|---|
| U1 | `a-d` | `a` only |
| U2 | `a-f` | `a` only |
| U3 | `c-f` | `c` only |
| U4 | `e` | `b` and `c` |
| U5 | `a` | `http-panel` |
| U6 | `b` | root |
| U7 | `c` | root |
| U8 | `http-panel` | root |

- **Order:** every instance sits above what it needs, so the rack starts bottom up and stops top down as usual. Where the dependency graph leaves the order open, a higher `priority` in the device file goes first. Priority is an integer that defaults to 0, and a device passes it down to what it needs. Layers, then names, settle the rest.
- **Cycles:** a cycle fails at startup with its path, for example `cycle: a.d → a-d.back → a`. The usual fix applies: the lower device emits events, and the upper one subscribes to them.
- **Several providers:** when several models provide a need's connector, `use` picks one, for example `use: { "kv/v1": "memkv", "a.cache": "redis" }`. A `<model>.<need>` entry wins over a connector id.
- **Configuration:** `config` gives configuration by instance name or by model, and an instance name wins. A device can also name its own resources after `ctx.slot.name`, so each copy gets its own.
- **Owners:** `status()` reports, for each copy, the `owner` whose `own` need it serves. In a manifest that places devices by hand, an `own` need must be wired to a device that nothing else is wired to.
- **Changes:** a scanned rack's instances come and go with its plan, so `plug`, `unplug`, and `swap` with another file fail with `RACK_SWAP_REJECTED`. `reload()` and `rack dev` replace the instances whose files changed. When the plan itself changes, for example with a new need, the running rack moves to the new plan as [Changed plans and edited manifests](#changed-plans-and-edited-manifests) describes.

### The plan file

The rack keeps the plan in `<rack name>.plan` next to the manifest, one line per instance with its slot, model, owner, and wiring. Commit it like a lockfile. It records the layout, not firmware versions, so only layout changes show up in review.

- The first start writes it. After that, `rack start` follows the file as written while it fits the devices. When it no longer fits, `rack start` refuses to start and lists the differences.
- A changed priority alone doesn't change the order `rack start` follows.
- `rack dev` rewrites the file whenever the devices or the priorities give another plan, and applies a new order to the running rack by moving slot numbers.
- `rack plan` prints the plan without starting the rack. `rack plan --write` writes the file, and `rack plan --check` exits with code 1 while the file is missing or no longer fits, for CI.
- `rack start --no-plan`, `rack dev --no-plan`, and `start(manifest, { plan: false })` run without a plan file; the graph and the priorities alone decide the order.

## Running a rack

From the command line:

```sh
rack start [manifest]   # default: rack.ts in the current directory
rack dev [manifest]     # start, then reload devices whose files change
rack plan [manifest]    # print the plan without starting; --write or --check the plan file
rack ctl <operation>    # operate the rack running from this directory; see below
```

On `SIGINT` (Ctrl-C) or `SIGTERM`, and on Windows on `SIGBREAK` (Ctrl-Break), both commands shut down in order. Their exit codes:

| Code | When |
|---|---|
| 0 | The rack shut down in order. |
| 1 | The rack failed to start, or a second stop came during the shutdown and ended it at once. |
| 2 | The command line is wrong, such as an unknown command or flag. |

`rack start` and `rack dev` also take:

| Flag | Meaning |
|---|---|
| `--log text`, `--log json` | `text`, the default, prints one line per entry, with warnings and errors on stderr. `json` prints each entry as one line of JSON on stdout, warnings and errors included: `{ time, level, device?, message, data? }`. A `bigint` in `data` is written as a string ending in `n`, and details that JSON can't hold, such as circular ones, as their `String()`. |
| `--stop-on-stdin-close` | Read standard input, drop what arrives, and shut down in order when it closes, as on `SIGTERM`. Signals and `rack ctl stop` work as before: whichever comes first starts the shutdown, and a second one ends it at once. |

**Running a rack from another program.** A program in another language, such as the Rust shell of a desktop app, runs `rack start --stop-on-stdin-close --log json` as a child process, with its standard input a pipe that it keeps open.
- **What it learns from the log:** the `listening` entry of each listener carries `device` and `data.url`, a panel on port 0 included; `rack <name> started` comes once every device is online; and `control listening` carries the endpoint's `address`.
- **Stopping the rack:** the program closes the pipe, which works on every system. When the program ends for any reason, a crash or a kill included, the system closes the pipe, and the rack stops by itself.
- **Waiting:** the shutdown takes as long as the rack's timeouts allow, such as `drainTimeout` and `hookTimeout`. A program that must not wait that long gives the rack a grace period of its own, then kills it.
- **Windows:** a program can start its children in a job object that the system ends together with the program, as `Bun.spawn` does unless the child is detached. A rack started that way ends at once with its program, without its shutdown. Such a program starts the rack detached, with `Bun.spawn`'s `detached: true`.
- The command line's own messages, such as a usage error, are text on stderr.

A program written in Bun can instead run a rack inside itself with `start()`, with its own `logger`.

`rack dev` watches the base directory, ignoring `node_modules` and dot directories. After a change it rebuilds every device and replaces the ones whose firmware hash changed, so editing a file that several devices bundle, such as a shared connector, replaces all of them. A device that fails to build keeps running its old firmware. Edits to the manifest itself take effect at once, as [Changed plans and edited manifests](#changed-plans-and-edited-manifests) describes.

From code:

```ts
import { start } from "rack42u";
import manifest from "./rack.ts";

const running = await start(manifest, { baseDir: import.meta.dir });
await running.call("greeter.greeter", "greet", { name: "Ada" }); // "Hello, Ada"
await fetch("http://localhost:3000/greet?name=Grace").then((r) => r.text()); // "Hello, Grace"
await running.stop();
```

| `start` option | Default | Meaning |
|---|---|---|
| `baseDir` | working directory | Where relative paths resolve and `.rack/` is written. |
| `logger` | one line per entry on the console | Receives every log entry. |
| `callTimeout` | 30 000 ms | Timeout of calls that set none. |
| `hookTimeout` | 30 000 ms | Timeout of boot, each lifecycle hook, and each `metrics()` request. |
| `drainTimeout` | 10 000 ms | How long a retiring instance may finish its calls. |
| `probation` | 60 000 ms | How long a new instance may crash before it falls back to known-good firmware; 0 turns fallback off. |
| `historyLimit` | 256 | Most update records `history()` keeps. |
| `watchdog` | 10 000 ms | Timeout of every device's event-loop watchdog, at least 1 000; 0 turns off every watchdog. See [Hangs and watchdogs](#hangs-and-watchdogs). |
| `queueLimit` | 10 000 | Most calls a need has unfinished, and most events that wait for one subscriber. See [Overload](#overload). |
| `control` | off | Open the management endpoint: `true` for the platform's default, or `{ port, token? }` for loopback TCP. |
| `plan` | `true` | How a scanned rack uses its plan file: `true` follows it, `"update"` rewrites it as `rack dev` does, and `false` neither reads nor writes it. |

The handle returned by `start`:

| Method | Purpose |
|---|---|
| `status()` | Each device's slot, height, state, firmware and known-good hashes, probation, calls in flight, recent crashes, watchdogs, stuck threads, and, for a copy, its `owner`. |
| `call(address, method, input, options?)` | Call a port from outside the rack. |
| `swap(name, source?)` | Replace a device now, optionally with another device file. |
| `restart(name, { cascade? })` | Stop a device and start it again from scratch; its direct consumers then reload. |
| `reload(manifest?)` | Rebuild all firmware and replace the devices whose hash changed; with a manifest, also move to its layout. |
| `rollback(name, { to? })` | Go back to earlier firmware that the history keeps. |
| `history(name?)` | List the updates, newest first. |
| `plug(u, slot(...))` / `unplug(name)` | Add a device to a free slot, or remove one that nothing uses. |
| `subscribe(listener)` | Receive power, swap, fault, and log events. |
| `metrics()` | Read each device's call and event counters, and the rack's counters of calls from outside the rack. |
| `stop()` | Shut down from the top down. |

Management operations run one at a time, in the order they were called. Firmware is written to `.rack/firmware/` under the base directory; keep `.rack/` out of version control.

`metrics()` resolves with `{ devices, outside }`. `devices` has one entry per device whose installed instance answered, bottom slot first. Each entry has the device name, the `firmware` hash of the instance that counted, `since` (when that instance booted), its event-loop delay `loop`, and counters per member:

```js
{
  device: "orders",
  firmware: "7f3a9c…",
  since: 1763260000000,
  loop: { delayMs: 0.4, maxDelayMs: 12.5 }, // see "Hangs and watchdogs"
  provides: { // per provided port and member
    http: { handle: { kind: "rpc", calls: 812, ok: 809, errors: { RACK_TIMEOUT: 3 }, active: 1, timeMs: 931.2 } },
  },
  needs: { // per need and member
    cache: {
      get: { kind: "rpc", calls: 790, ok: 790, errors: {}, pending: 0, queued: 0, timeMs: 18.4 },
      changed: { kind: "event", received: 12 },
    },
  },
}
```

- For the RPC members a device provides, `calls` counts the calls it served, including calls from `rack.call` and the HTTP panel; `active` counts the ones it is still serving. For the RPC members of its needs, `calls` counts the calls it made; `pending` counts the unfinished ones, and `queued` the ones waiting while the provider is swapped.
- `ok` counts successes and `errors` counts failures by error code, `RACK_TIMEOUT` and `RACK_CANCELLED` included. `timeMs` is the total duration of the finished calls, so `timeMs / (ok + errors)` is the mean.
- An event member a device provides counts `emitted` events and `dropped` deliveries; one it needs counts `received` events.
- A device's counters live in its Worker, which keeps them from the moment its instance boots, so they restart when a device swaps or resets. A device that does not answer within `hookTimeout` is left out.
- `outside` counts the calls from outside the rack, through `call()`, the way a need counts its calls, by address and member:

  ```js
  {
    ports: { // per <device>.<port> and member
      "greeter.greeter": { greet: { kind: "rpc", calls: 812, ok: 805, errors: { RACK_OVERLOADED: 7 }, pending: 0, queued: 0, timeMs: 1250.7 } },
    },
    unrouted: 0, // calls to an address or member that doesn't exist
  }
  ```

  - It includes the calls that the rack answered itself without reaching a device: refused at `queueLimit`, held past their deadline while the device swapped or reset, or sent to a device that was `faulted` or `resetting`.
  - The HTTP panel's calls are calls between devices, so they count under the panel's needs instead, as [HTTP panel](#http-panel) describes.
  - The main thread keeps these counters, so they last across swaps and resets. A port's counters start at its first call, and go away when its device is unplugged; a member's go away when a swap removes the member.
- After `stop()`, `metrics()` resolves with no devices and empty `outside` counters.

## Hot swap and hot reload

Every swap follows the same sequence:

1. The new firmware boots in a standby instance, and the rack checks that ports other devices use, a panel's routes included, still exist with the same connector. If not, the swap is rejected with `RACK_SWAP_REJECTED`.
2. The new instance runs `powerOn` and `selfTest` while the old one keeps serving.
3. The old instance runs `deactivate`. If the device has `snapshot`/`restore`, calls to the slot are held while the old instance finishes its calls, and its snapshot is restored into the new instance.
4. The new instance runs `activate`. Calls to the slot are held for a moment and then switch to it in one step; held calls go to the new instance, and none are lost.
5. The old instance finishes the calls it still holds, runs `powerOff`, and is terminated. Calls still running after `drainTimeout` fail with `RACK_LINK_DOWN`.

If anything in steps 1–4 fails, the new instance is discarded, the old one is reactivated and keeps serving, and the slot reports `degraded`. Its watchdogs watch it again from there. An old instance that doesn't answer `deactivate` within `hookTimeout`, or doesn't activate again, can't keep serving: the rack ends it and resets the device from its old firmware, as after a watchdog bite.

### Hot swaps, cold swaps, and restarts

The sequence above is a **hot swap**, and `reload()`, `rack dev`, and `swap()` use it by default. Two more kinds replace a device without letting its old and new instances overlap:

| | Hot swap | Cold swap | Restart |
|---|---|---|---|
| Old and new instance | Overlap; the new one starts first | Never overlap; the old one stops first | Never overlap |
| Calls to the device | Held for a moment | Held while it stops and starts | Held while it stops and starts |
| State | Moves through `snapshot` and `restore` | Moves through `snapshot` and `restore` | Starts fresh |
| Used for | Every compatible change | Devices that declare `swap: "cold"`, and contract changes | `rack.restart(name)` |

- **Cold swaps.** A device declares `swap: "cold"` when two of its instances must never run at the same time, for example because it holds a file lock or a serial port. The new instance starts only once the old instance's thread has stopped, even a thread blocked in native code, as [Stuck threads](#stuck-threads) describes. Calls that arrive meanwhile wait for the new instance, up to their own timeouts. If the new instance fails to start, the old firmware starts again from its snapshot, and the slot reports `degraded`.
- **Restarts.** `rack.restart(name)` rebuilds the device from its file and starts it from scratch, without its state. Its direct consumers then reload, keeping their state, so their `powerOn` runs again against the new instance. `{ cascade: false }` leaves the consumers running. If the restarted device fails to start, its old firmware starts again without state.
- **Contract changes.** A new firmware can change a port that consumers use, for example by moving a connector to `/v2`. When the consumers' new firmware matches the change, as it does when they share the edited connector file, the rack replaces the provider and those consumers together. The group stops top down and starts bottom up, with each device's state carried over. When a consumer's firmware does not match, nothing stops, and the replacement fails with `RACK_SWAP_REJECTED`.
- **Results.** `reload()` and `restart()` resolve with one result per device, and each result and `swap` event carries a `mode`: `hot`, `cold`, `restart`, `plug`, or `unplug`.

A hot swap hands over everything the rack holds. In-memory state crosses only through `snapshot`, because a Worker's memory cannot move to another Worker.

| Context | How it reaches the new instance |
|---|---|
| Calls in flight | They finish on the old instance before it retires |
| New calls | Held, then sent to the new instance in order |
| Links to and from other devices | Switched to the new instance in one step |
| Event subscriptions | Made again by the new instance, usually in `powerOn` |
| Events sent to it during the hold | Queued, then delivered, up to `queueLimit` |
| HTTP connections and WebSockets | Stay with the [HTTP panel](#http-panel), a device of its own; a device's own [listener](#listeners) hands its port over |
| Timers and background tasks | Stopped by `deactivate`, started again by `activate` |
| In-memory state | `snapshot` on the old instance, `restore` on the new one |
| Open files and sockets | Not handed over: the old instance closes them and the new one opens its own |

### Changed plans and edited manifests

When a scanned rack's plan changes, or `rack dev` sees the manifest change, the running rack moves to the new layout without a restart:

1. Devices that are new are plugged, from the bottom up, and devices that stay move to their new slots without restarting.
2. Devices whose firmware or configuration changed are replaced.
3. Needs whose provider changed are rewired. The device keeps running, and only its calls switch to the new provider.
4. Devices that left are unplugged, from the top down, once nothing uses them.

- **Failures:** each step leaves a valid rack. A step that fails is reported in the results of `reload()`, and the rest of the rack keeps running.
- **Under `rack start`:** the plan file decides. A new plan runs only once the file records it, for example after `rack plan --write`.
- **Restart needed:** renaming the rack, and switching between slots and scanned devices.
- **From code:** `reload(manifest)` applies an edited manifest the same way.

### Crashes

When a device crashes (an uncaught exception, an unhandled rejection, or `process.exit`), its calls in flight fail with `RACK_DEVICE_FAULT` and the rack resets it from the same firmware. Calls during the reset fail with `RACK_LINK_DOWN`. In-memory state does not survive a reset, so keep state that matters in a storage device. After more than 3 crashes within 60 seconds, the slot is marked `faulted` until a swap succeeds. When a device's longest watchdog timeout is longer than 15 seconds, the window is four times that timeout instead, so a device that hangs after every reset reaches the limit too.

### Hangs and watchdogs

A device can hang without crashing: its event loop stays blocked, or one of its work loops stops making progress. Watchdogs catch both.

- **The event-loop watchdog.** Every device has one, which its Worker host feeds from a timer. If the device's event loop stays blocked for `watchdog` milliseconds, 10 000 by default, the watchdog bites.
- **Device watchdogs.** In `activate`, a device arms a watchdog for each work loop it wants watched, and feeds it from that loop:

  ```ts
  activate(ctx, scope) {
    const dog = scope.watchdog(5_000, "poller");
    void (async () => {
      while (!scope.signal.aborted) {
        await pollOnce(ctx);
        dog.feed();
      }
    })();
  },
  ```

  - `scope.watchdog(ms, name?)` bites when `feed()` isn't called for `ms` milliseconds, at least 1 000. `name` defaults to `watchdog 1`, `watchdog 2`, and so on.
  - `cancel()` disarms the watchdog, and `deactivate` disarms them all. A device can have 16 armed at once.
- **What a bite does.** A watchdog bites between 1 and 1.25 times its timeout after its last feed.
  - The device's calls in flight fail with `RACK_DEVICE_FAULT`, and the rack resets the device as after a crash, or falls back to its known-good firmware during probation. Bites count toward the crash limit.
  - The slot's error names the watchdog in its `data`: `{ watchdog: "poller", timeout: 5000 }`, or `{ watchdog: "event loop", timeout: 10000 }`.
- **Hangs in native code.** A device blocked inside native code, such as a long SQLite query or a blocking file read, stops only when that call returns. If its thread hasn't stopped within `hookTimeout` of the bite, the thread is stuck, and the slot is `faulted` until the thread stops and a swap or restart succeeds, as [Stuck threads](#stuck-threads) describes.
- **When watchdogs watch.** From the end of `activate` to the start of `deactivate`; `hookTimeout` bounds the hooks instead.
- **Turning them off.** `watchdog: 0`, or `--no-watchdog` for `rack start` and `rack dev`, turns off every watchdog, for example while a debugger holds devices at breakpoints. Raise `watchdog` instead for devices with long synchronous work, such as large SQLite queries.
- **Observing them.** `status()` lists each device's `watchdogs`, the event loop's first, with their `name`, `timeout`, and `lastFed`. `metrics()` reports each device's event-loop delay as `loop: { delayMs, maxDelayMs }`, the delay of the last tick of the event-loop watchdog's timer and the largest since the instance booted.

### Stuck threads

Wherever the rack stops an instance, in a swap, restart, rollback, unplug, reset, watchdog bite, or `stop()`, it ends it the same way: it terminates the instance's Worker and waits up to `hookTimeout` for the Worker's thread to stop.

- **Unanswered hooks.** While an instance stops, a hook that it doesn't answer within `hookTimeout` is its last. Its calls in flight fail with `RACK_DEVICE_FAULT`, and the rack ends it without waiting for its calls to drain or sending it `snapshot` or `powerOff`.
- **Stuck threads.** A thread blocked inside native code, such as a long SQLite query or a blocking file read, stops only when that call returns. One that hasn't stopped within `hookTimeout` of its termination is stuck. The rack logs it, emits a `fault` event, and lists it among the device's `stuck` threads in `status()`, with its `firmware` and `since`, when the rack terminated it. When the thread stops, the rack logs that too.
- **No second instance.** While a thread of a device is stuck, no other instance of the device starts:
  - `swap()`, `restart()`, `rollback()`, and `reload()` fail with `RACK_SWAP_REJECTED` for the device.
  - A cold swap or restart whose old thread gets stuck fails with `RACK_DEVICE_FAULT`, and the slot is `faulted`.
  - A reset, after a crash or a watchdog bite, leaves the slot `faulted` instead.
  - `unplug()` fails with `RACK_DEVICE_FAULT`, and the device stays in the rack, `faulted`.

  Once the thread stops, a swap or restart brings the device back, and `unplug()` removes it.
- **Firmware that gets stuck loading.** If a device file's top-level code gets stuck in native code while the rack loads it, the operation fails, and the rack doesn't load that firmware again until the thread stops.
- **Limits.** Only a restart of the rack reclaims a thread whose native call never returns. `stop()` waits for the threads of all devices together, so a stuck thread delays it by one `hookTimeout` at most.

## Update safety

An update can pass `selfTest` and still be defective. The rack guards against that in two ways.

**Passive fallback.**
- **Known-good firmware.** Each device has one: the firmware it started with at cold start, or the last firmware that got through probation.
- **Probation.** After an update, the new instance is on probation for `probation` milliseconds, 60 000 by default.
- **Falling back.** If the instance crashes on probation, or a watchdog bites, the rack does not reset it from the same firmware. It starts the known-good firmware instead, fresh, and the slot reports `degraded` with the crash as its error. A group replaced together for a contract change falls back together, so providers and consumers keep matching contracts.
- **Limits.** A device falls back at most once per update. Setting `probation: 0` turns fallback off.
- **Status.** `status()` shows each device's `knownGood` firmware hash, and `probationUntil` while it is on probation.

**Active rollback.**
- `rack.rollback(name)` goes back to the firmware before the current one, as a hot or cold swap, keeping the state. Undoing a group replacement takes the whole group back.
- `rack.rollback(name, { to: hash })` goes back to any firmware the history still keeps.
- A rollback restores code only. When the earlier firmware has other needs than the running plan, the rollback fails with `RACK_SWAP_REJECTED`, and nothing changes.

**History.**
- `rack.history(name?)` lists the updates newest first, for the whole rack or for one device. That covers every swap, cold swap, restart, plug, unplug, rollback, and fallback, whether it succeeded or failed.

  ```js
  { seq: 12, time: 1763300000000, device: "orders", mode: "restart", cause: "fallback",
    from: "9c1e…", to: "7f3a…", ok: true, error: { code: "RACK_DEVICE_FAULT", message: "…" } }
  ```

- **Fields.** `cause` says what asked for the update: `reload`, `swap`, `restart`, `rollback`, `fallback`, `plug`, or `unplug`. Records of one group replacement share a `group`. The rollback records are the ones whose cause is `rollback` or `fallback`.
- **Limit.** The history keeps at most `historyLimit` records, 256 by default, in memory, and a restart of the rack starts it empty.
- **Firmware files.** The rack deletes the firmware bundles it built once nothing needs them: no instance, no known-good firmware, and no kept record. So `.rack/firmware/` stays bounded, and `rollback` reaches only the firmware the kept records name.

## Overload

A device that falls behind can't take the rack down with it: every backlog between devices has a limit, and what goes beyond the limit fails at once.

- **Calls.** A need has at most `queueLimit` calls unfinished, 10 000 by default: calls on their way, being served, and held while the provider swaps.
  - Calls from outside the rack, through `call()`, are counted per device the same way. The HTTP panel's calls are calls of its needs, bounded as any.
  - A call beyond the limit fails at once with `RACK_OVERLOADED`, without reaching the provider. The HTTP panel answers it with 503.
- **Events.** A subscriber that falls `queueLimit` events behind misses the next ones. The provider counts them in `dropped`, and `emit` doesn't fail. Subscribers that keep up get every event.
- **Expired calls.** A provider doesn't start a call whose deadline passed while the call waited. It answers `RACK_TIMEOUT` at once, so a provider that falls behind spends its time on calls that someone still waits for.
- **Observing it.**
  - A refused call counts under `RACK_OVERLOADED` among the errors of its need in `metrics()`, and an expired call under `RACK_TIMEOUT` among the errors of the provider's member.
  - A refused call from outside the rack counts in the `outside` counters of `metrics()`, under its port and member.
  - `pending`, `active`, and the event-loop delay `loop` show load building up.
- **Policy stays in devices.** The rack doesn't retry, open circuit breakers, or limit rates on its own, since whether to retry, wait, or degrade depends on the device. A device can refuse work for a limit of its own, such as a pool of connections, by throwing `RACK_OVERLOADED`; callers and the HTTP panel treat it the same way.

## Managing a running rack

`rack start` and `rack dev` open a management endpoint, and `rack ctl` operates the rack through it:

```sh
rack ctl status                          # each device's slot, state, and firmware
rack ctl metrics
rack ctl reload
rack ctl swap <device> [source]
rack ctl restart <device> [--no-cascade]
rack ctl rollback <device> [--to <firmware>]
rack ctl history [device]
rack ctl stop                            # shut down in order, like Ctrl-C
```

`rack ctl` finds the rack whose base directory is the current directory, or `--dir <path>`, even when the rack and `rack ctl` reach that directory by different paths, such as through a symlink. It prints the result as JSON and exits with 0, or prints the error and exits with 1.

**Who can connect.** Nothing listens on the network.
- On Linux and macOS, the endpoint is a Unix socket in a directory that only your user can enter: `$XDG_RUNTIME_DIR/rack42u/`, or `~/.local/state/rack42u/control/`. Only your user and root can connect.
  - A socket left behind by a rack that crashed is replaced.
  - While a rack answers on the socket, a second rack for the same directory refuses to start.
- With `--control-port <port>`, and by default on Windows, the endpoint listens on loopback TCP, `127.0.0.1`.
  - Every request needs the rack's token as `Authorization: Bearer <token>`. The token is random on each start, unless `RACK_CONTROL_TOKEN` sets it.
  - The rack writes the address and the token to a control file in the same private directory. On Windows, that directory is `%LOCALAPPDATA%\rack42u\control\`.
  - The endpoint refuses requests that carry an `Origin` header or a `Host` other than its own, so a web page cannot drive it.
  - `rack ctl --url <url> --token <token>` reaches such a rack from anywhere on the machine.

**The protocol.** Each operation is `POST /v1/<operation>` with the body `{ "args": [...] }`, and runs the rack-handle method of the same name.
- It answers `{ "ok": true, "value": ... }`, or `{ "ok": false, "error": { code, message } }`.
- `plug` takes its slot spec as `{ source, name?, config? }`.
- Operations from the endpoint and from code share one queue, so they run one at a time, in call order.

From code, `start(manifest, { control: true })` opens the same endpoint.

## Testing a device

`rack42u/bench` runs one device in a rack of its own, with a stub for each of its needs that the test implements, and records what the device does. For the greeter of [Devices](#devices):

```ts
// devices/greeter.test.ts
import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Kv } from "rack42u/std";

test("greeter greets and remembers the last name", async () => {
  const store = new Map<string, string>();
  await using greeter = await bench(new URL("./greeter.ts", import.meta.url), {
    config: { prefix: "Hello," },
    needs: {
      cache: stub(Kv, {
        get: (key) => store.get(key) ?? null,
        set: ({ key, value }) => {
          store.set(key, value);
        },
      }),
    },
  });
  expect(await greeter.call("greeter", "greet", { name: "Ada" })).toBe("Hello, Ada");
  expect(store.get("last")).toBe("Ada");
  expect(greeter.needs.cache.calls).toContainEqual(expect.objectContaining({ member: "set" }));
  await greeter.swap(); // a hot swap, with snapshot and restore
  expect(await greeter.call("greeter", "greet", { name: "Grace" })).toBe("Hello, Grace");
});
```

`bench(source, options)` builds the device file into firmware and runs it as any rack would: in its own Worker, with its configuration validated, its hooks, copies at every boundary, timeouts, cancellation, swaps, and resets. Below it, a stub device stands in for each need, and above it a probe records the events it emits. It resolves once the device is online.

| Option | Meaning |
|---|---|
| `needs` | One `stub()` per need, by need name, `own` and `patched()` needs included. |
| `config`, `name` | As `slot()` takes them. |
| Others | Those of `start()`, such as `baseDir`, `callTimeout`, and `watchdog`; the bench records the log itself. |

A need without a stub, a stub of another connector, and a stub for a need the device doesn't have fail with `RACK_MANIFEST`. Otherwise `bench()` fails as `start()` does.

**Stubs.** `stub(connector, implementation)` takes functions for some or all of the connector's RPC members, with the arguments a port's functions get.
- The connector's schemas validate each call's input and output in the test, as the rack validates them at a provider: invalid input fails the device's call with `RACK_INVALID_INPUT`, and invalid output with `RACK_INVALID_OUTPUT`.
- An implementation that throws a `RackError` gives the device that error's code; any other error, or a call to a member without an implementation, reaches it as `RACK_DEVICE_FAULT`. One that never settles lets the device's call time out, and its `call.signal` aborts.
- `stub.calls` records each call the stub got, invalid ones included, as `{ member, input, at }`.
- `stub.emit.<event>(payload)` emits one of the connector's events to the device. The schema validates the payload, which fails with `RACK_INVALID_OUTPUT`, and the promise resolves once the stub has emitted it.
- Calls to a stub copy their data, and `call.transfer()` does nothing. A stream in a call's input or result crosses read whole, up to 16 MiB, and `calls` records it as its bytes, a `Uint8Array`. A larger one fails the call with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
- A stub serves one running bench at a time.

**The bench.**

| Member | Purpose |
|---|---|
| `call(port, member, input, options?)` | Call a port of the device, as `rack.call()` calls `<device>.<port>`. |
| `events` | The events the device emitted, as `{ port, event, payload, at }`. They come through the probe's Worker, so one can arrive just after the call that emitted it returns. |
| `logs` | The rack's log entries, the device's included. |
| `faults` | The device's crashes and watchdog bites, as `{ firmware, error, reset, at }`. |
| `swap(source?)`, `restart()`, `reload()` | Replace the device, as the rack handle's methods do. |
| `rack` | The rack handle, for `status()`, `metrics()`, `history()`, and the rest. |
| `stop()` | Stop the rack and delete the bench's files; `await using` calls it at the end of the scope. |

- The device emits as in any rack: an event emitted before the device is installed is dropped, such as one from `powerOn` during a swap, and so is one beyond `queueLimit`, which is counted.
- `calls`, `events`, `logs`, and `faults` keep the last 10 000 records each; `stub.dropped` and `bench.dropped.events`, `.logs`, and `.faults` count the older ones.
- The bench writes its stub and probe device files into a directory under `.rack/bench/` in the base directory, and deletes it when it stops. `status()` lists them as `stub-<need>` and `probe`.
- A device's [listeners](#listeners) work as in any rack, and `status()` shows their URLs.
- One device per bench. A test of several real devices together starts a rack.

## Standard devices

`rack42u/std` exports the standard connectors and the factories that mount the standard devices.

- **`memkv(options?)`** provides `kv: Kv` (`kv/v1`), an in-memory store of string keys and string values: `get(key)`, `set({ key, value })`, `delete(key)`, `keys(prefix)`, and a `changed` event with the key after every `set` and every `delete` that removed a key. Entries move to the new instance during swaps and hot reloads; a restart starts empty.
- **`sqlite(config, options?)`** provides `sql: Sql` (`sql/v1`) on `bun:sqlite`: `query({ sql, params? })` returns rows as objects, `run({ sql, params? })` returns `{ changes, lastInsertRowid }`, and `batch([...statements])` runs statements in one transaction and rolls back if one fails. Parameters bind to positional `?` placeholders. `config.path` is relative to the base directory, missing directories are created, and file databases use WAL mode; `":memory:"` gives an in-memory database that moves to the new instance during a swap. Database errors fail with `SQL_ERROR`, with the driver's code, such as `SQLITE_CONSTRAINT_UNIQUE`, in `data.code`.

- **`httpPanel(config, options?)`** mounts `http-panel`, the standard HTTP panel, which [HTTP panel](#http-panel) describes.

Each factory takes `{ name }` in `options` to rename the device.

### HTTP panel

`httpPanel(config, options?)` mounts the HTTP panel, `http-panel`. It listens for HTTP and WebSocket on a [listener](#listeners) of its own, and passes each request, and each WebSocket message, to the port its route names. Such a port implements `http/v2`, to which `httpHandler` adapts a fetch-style function:

```ts
// devices/web.ts
import { device } from "rack42u";
import { Http, httpHandler } from "rack42u/std";
import { Greeter } from "../connectors.ts";

export default device({
  model: "web",
  needs: { greeter: Greeter },
  provides: { http: Http },
  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const name = new URL(request.url).searchParams.get("name") ?? "world";
      return new Response(await ctx.ports.greeter.greet({ name }));
    }),
  }),
});
```

**Routes.** `routes` maps [Bun route patterns](https://bun.sh/docs/api/http#routing), such as `/orders/:id` and `/api/*`, to `<device>.<port>` addresses. Each distinct address is a need of the panel, which [`patched()`](#needs-from-configuration) wires to it, named after the address with `.` and `-` as `_`, such as `orders_http`, and with a `_` in front of a leading digit. So the rules of needs apply:

- The panel sits above every device it routes to. A route to a device that isn't below it, to an unknown device, or to a port that isn't `http/v2` fails with `RACK_MANIFEST`. Two addresses that give one need name fail with `RACK_INVALID_CONFIG`.
- In a scanned rack, list the panel in `roots`; its routes pull in the models they name.
- Each request goes to the instance installed at that moment, so swaps of the devices behind the panel don't interrupt it. A swap that removes a routed port is refused, as for any port in use.
- Editing the panel's configuration, its routes included, replaces the panel without a restart. A new port moves its listener.
- `{ name }` in `options` names a panel other than `http-panel`, so that a rack can mount several, such as a public one and an admin one on another port.

| Field | Default | Meaning |
|---|---|---|
| `hostname` | `127.0.0.1` | The address to listen on. `0.0.0.0` listens on every IPv4 interface. |
| `port` | required | 0 to 65 535. 0 picks a free port, which the panel keeps while the rack runs, and which the log's `listening` entry and `status()` show. |
| `routes` | required | Route patterns mapped to `<device>.<port>` addresses. Unmatched paths get 404. |
| `allowedHosts` | none | More names that clients may send as `Host` to a panel on a loopback `hostname`, besides its address and `localhost`. Other hosts get 403. |
| `maxBodySize` | 1 MiB | The largest request body, in bytes. A larger one gets 413. |
| `streamThreshold` | 256 KiB | The largest request body, in bytes, that goes to the device whole. A body with a declared length up to it must arrive within `idleTimeout`; a larger one, and a chunked one, streams. |
| `idleTimeout` | 10 | Seconds, 1 to 255. An idle connection closes, a body sent whole that hasn't arrived within it fails, and so does a streamed body that moves nothing for so long. |
| `tls` | none | `{ cert, key }`, or a list of `{ cert, key, serverName }` for SNI: paths of PEM files, relative to the base directory. |
| `certificateCheck` | 60 | How often the panel checks its certificate files, in seconds, 1 to 3 600. |
| `webSocket.maxMessageSize` | 1 MiB | The largest message a client may send, in bytes. A larger one closes its WebSocket with 1009. |
| `webSocket.maxConnections` | 10 000 | The most open WebSockets. Upgrades beyond them get 503. |

A configuration that doesn't validate fails the panel's boot with `RACK_INVALID_CONFIG`.

**Requests.** The panel's call carries the method, URL, headers, route parameters, and body. `httpHandler` hands your function a standard `Request`, whose `signal` aborts when the client goes away or the call times out, and keeps duplicate response headers, such as several `Set-Cookie` headers.

- **Bodies.** A request body with a declared length of at most the panel's `streamThreshold`, 256 KiB by default, goes to the device whole, and a longer or chunked one streams, as [Streams](#streams) describes. Either way, it reaches your function as `request.body`. A response body that ends at once within `httpHandler`'s `streamThreshold`, 16 MiB by default, goes back whole, and any other streams, so server-sent events and large downloads start at once:

  ```ts
  http: httpHandler({ fetch: app.fetch, streamThreshold: 256 * 1024 }), // responses over 256 KiB stream
  ```

  A body sent whole moves in one message, which is faster, while it holds all of its bytes until the other side takes them; a body that streams holds at most a stream's window in flight, and the slower side slows the other. `streamThreshold` is an integer of 0 or more, and 0 streams every body that has bytes.

  A response body sent whole keeps its `Content-Length` at every size, as [`wholeResponse()`](#listeners) builds it. A body that streams goes out with chunked encoding, without `Content-Length`, even when the device names one: Bun can't send a stream with its length.
- **Timeouts.** The call's timeout, `callTimeout`, runs from the end of the request body to the response head. A body sent whole must arrive within `idleTimeout`, so a client must send at least `streamThreshold / idleTimeout` on average, 25.6 KiB/s with the defaults, for the largest; raise `idleTimeout`, or lower `streamThreshold`, for slower clients. A body that streams fails once it moves nothing for `idleTimeout`, in either direction. Bun's own timer, which would cut a whole exchange, doesn't run while a request is under way.
- **Statuses.** Where the panel writes the body, it is JSON, `{ code, message }`:

  | Outcome | Status |
  |---|---|
  | `RACK_LINK_DOWN`, or `RACK_OVERLOADED`, also at the need's `queueLimit` | 503 |
  | No response head within `callTimeout`, or a device that stopped reading the body for `idleTimeout` | 504 |
  | A body sent whole that hasn't arrived within `idleTimeout`, or a streamed body that the client stopped sending for `idleTimeout` | 408 |
  | Any other error, and response headers that `Response` rejects | 502 |
  | A body over `maxBodySize` | 413, with an empty body; a body that streamed fails at the device with `RACK_INVALID_INPUT` |
  | Another host, on a loopback `hostname` | 403 |
  | No route matches | 404, with the code `RACK_NO_ROUTE` |

- **After the head.** A response body that fails, or moves nothing for `idleTimeout`, after its head went out ends the response abruptly, so the client sees an incomplete body. A client that goes away cancels the call and its streams, with `RACK_CANCELLED` at the device.

**WebSocket.** WebSocket is part of the HTTP panel, on the same routes. For it, `httpHandler` takes WebSocket handlers and the port's emitter:

```ts
powerOn: (ctx) => ({
  http: httpHandler(
    {
      fetch(request, server) {
        if (request.headers.get("origin") !== "https://app.example") {
          return new Response("forbidden", { status: 403 });
        }
        if (server.upgrade(request, { data: { user: "ann" }, protocol: "chat" })) return;
        return new Response("hello");
      },
      websocket: {
        open: (ws) => ws.send("welcome"),
        message: (ws, data) => ws.send(data),
        close(ws, code, reason) {},
      },
    },
    ctx.emit.http, // what the sockets send travels as this port's events
  ),
}),
```

- **Upgrades.** An upgrade request reaches `fetch` like any request. `server.upgrade(request, { headers?, data?, protocol? })` accepts it, and `fetch` then returns nothing; without `protocol`, the client gets the first subprotocol it offered. Any response refuses it.
- **Messages.** Text arrives as a string, and binary as a `Uint8Array`. Each message is a call, and a socket has at most 16 unfinished: beyond that, the panel stops reading the socket, so the client sees backpressure, and the calls start in the order the messages arrived. A failed `open` or `message` closes the socket, with 1013 for the codes that give 503, and 1011 for the others.
- **Sockets.** Each socket has an `id`, `<panel>:<instance>:<n>`, its `data`, and `send()` and `close()`, which travel as the port's `send` and `close` events. A device can emit those events itself too, to one id or a list. Each panel takes the events for its own sockets and ignores the others, so several panels can share one port.
- **Swaps.** A hot swap of the device keeps its sockets open. Return `handler.list()` in the state of `snapshot`, and pass it to `handler.restore(list)` in `restore`, so that the new instance knows them. A reset or a restart of the device loses them: their sockets close with 1011, at their next message, or at the panel's second check of its sockets, which runs every 30 s. Swapping the panel closes its WebSockets with 1012, once the messages in flight on them are handled; clients must reconnect.
- **Limits.** A client that reads too slowly, with more than 1 MiB unsent, is closed with 1013. When the panel crashes, its clients' connections end, and each device behind it runs its `close` handler with 1006, "abnormal closure", for the panel's sockets, at its first call after 90 s without a call from that panel.
- **Origins.** Browsers apply no CORS to WebSockets, and any web page can send requests to `127.0.0.1`. A panel on loopback refuses other `Host` names, which stops a page that points its own domain at `127.0.0.1`, but not one that uses the address itself. So a device behind a panel checks the `Origin` of WebSocket upgrades, and of requests that change state, itself.

**Certificates.** With `tls`, the panel serves HTTPS and WSS, and a pair that doesn't load fails its `powerOn`.

- Every `certificateCheck` seconds, the panel reads the files again. A pair that changed and loads replaces the old one without a restart: new connections get it, and connections opened before keep working. With SNI, each pair is checked on its own, and unknown names get the first.
- A pair that changed and doesn't load, such as a key that doesn't match its certificate, leaves the old pair serving. If it still doesn't load at the next check, the log has an error, `certificates rejected`, once until its files change again. So a renewal that writes the certificate and then the key loads at the check after the second write, without an error.
- Tools that renew certificates should write each file under a temporary name and rename it, so that the panel never reads half a file.
- `status()` shows each certificate's subject and expiry, `notAfter`, in the entry of the panel's listener.

**Observation.** The panel's needs count its calls per route target, as every need does, with `streams` for the bodies that streamed. The entry of its listener in `status()` shows its requests in flight and its open WebSockets. Answers for which no call reached a device count nowhere, such as 404, 403, and 413 for a declared length. The log warns when the panel starts refusing upgrades at `maxConnections`, and says when it accepts them again.

`http/v2` has these members:

| Member | Kind | Carries |
|---|---|---|
| `handle` | RPC | `{ method, url, headers, params, body, socket? }` to `{ status, headers, body }`, or to `{ upgrade: { protocol?, headers? } }` for an upgrade request, which alone carries `socket` |
| `opened`, `closed` | RPC | `{ socket }` when a WebSocket opened, and `{ socket, code, reason }` when it closed |
| `message` | RPC | `{ socket, data }`, a message from the client |
| `sockets` | RPC | `{ instance, open }` to `{ unknown }`: the panel's check of the sockets one side lost |
| `send`, `close` | event | `{ socket, data }` and `{ socket, code?, reason? }`, to one socket id or a list |

Headers are arrays of `[name, value]` pairs, and a body is `null`, a `Uint8Array`, or a stream. `httpHandler` answers `sockets` itself: it treats a socket as closed once two checks in a row from its panel left it out.


## Error codes

Errors cross the backplane as `RackError`s with a `code`, a `message`, and optional `data`.

| Code | Meaning |
|---|---|
| `RACK_TIMEOUT` | The call timed out. |
| `RACK_CANCELLED` | The caller cancelled the call. |
| `RACK_LINK_DOWN` | The provider is offline, resetting, faulted, or retired, or the rack is stopped. |
| `RACK_NO_ROUTE` | No such device, port, or method. |
| `RACK_INVALID_INPUT` / `RACK_INVALID_OUTPUT` | Input or output failed its schema, cannot be cloned, or lists a buffer that cannot be transferred. |
| `RACK_INVALID_CONFIG` | A device's configuration failed its schema. |
| `RACK_DEVICE_FAULT` | The device threw a non-`RackError` exception, crashed, hung until a watchdog bit, stopped answering its hooks while it stopped, or has a stuck thread. |
| `RACK_OVERLOADED` | The call would exceed `queueLimit`, or the device refused it for a limit of its own. |
| `RACK_MANIFEST` | The manifest or the assembly is invalid. |
| `RACK_SWAP_REJECTED` | A swap, plug, unplug, or reload was refused, for example while a thread of the device is stuck. |
| `RACK_HOOK_FAILED` | A lifecycle hook failed or timed out. |

## Windows

rack42u runs on Windows as it does on Linux and macOS, with these differences:

- **Stopping.** Ctrl-C and Ctrl-Break stop `rack start` and `rack dev` in order, as `rack ctl stop` does. Windows has no `SIGTERM`. A process ended from outside, such as by Task Manager or `taskkill /F`, ends at once, as with `SIGKILL` elsewhere. Closing its console window ends the rack without an orderly shutdown, as a hangup does elsewhere.
- **The management endpoint** listens on loopback TCP with a token, since Windows has no Unix sockets. See [Managing a running rack](#managing-a-running-rack).
- **The control file.** Windows has no file modes: the control file is as private as `%LOCALAPPDATA%`, the local application data folder of your user profile.
- **Paths.** The rack reports paths with `\`, such as `source` in `status()`. Manifests may write relative paths with `/` on every system.

## Not supported yet

- Devices run only as `sled` (one Worker each); the `inline` and `chassis` forms are planned.
- A management dashboard.
- Connecting several racks, and packaging a rack with `bun build --compile`.

## Development

| Purpose | Command |
|---|---|
| Run all tests | `bun test` |
| Type check | `bun run typecheck` |
| Lint and format check | `bun run lint` |
| Check decision records | `bun run check:decisions` |
| All of the above | `bun run check` |

CI runs for every push to `main`, and on request: `bun run check` on Linux, and `bun test` on macOS and Windows. A failure on any of the three fails the run. To check a branch before merging it, start the workflow by hand with "Run workflow" on the Actions tab, or with `gh workflow run check.yml --ref <branch>`.

Design decisions live in [`.agents/decisions/`](.agents/decisions); [`AGENTS.md`](AGENTS.md) explains how the project is run.

## License

[MIT](LICENSE)
