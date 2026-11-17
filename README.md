# rack42u

rack42u is a Bun framework for building an application out of hot-swappable **devices** mounted in a 42U-style **rack**. Each device runs in its own Worker, talks to other devices only through the rack's **backplane**, and can be replaced, reloaded, plugged in, or unplugged while the rack keeps running.

The framework provides the rack runtime and a few standard devices. What you mount in the rack, and whether the result is an API server, a worker process, or something else, is up to you.

> **Status: P0.** This is the first usable version. See [Not in P0](#not-in-p0) for what is still missing.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later. rack42u runs only on Bun; it is published as TypeScript source.

## Try the example

The repository contains an example app, [`examples/shop-api`](examples/shop-api): a SQLite database at the bottom of the rack, an in-memory cache above it, and an orders API on top.

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
| Panel | An external port owned by the rack. P0 has an HTTP panel. |
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
| `ctx.ports.<need>.<method>(input, { timeout?, signal?, transfer? })` | Call a needed connector. |
| `ctx.on.<need>.<event>(handler)` | Subscribe to an event; returns an unsubscribe function. |
| `ctx.emit.<port>.<event>(payload)` | Publish an event on a provided port. |
| `ctx.config` | The configuration, validated by the `config` schema. |
| `ctx.log.debug/info/warn/error(message, data?)` | Log through the rack. |
| `ctx.signal` | Aborts after `powerOff`. |
| `ctx.slot`, `ctx.firmware`, `ctx.baseDir` | `{ name, u }`, the firmware hash, and the rack base directory. |

`activate` also receives `scope`. `scope.every(ms, task)` and `scope.after(ms, task)` schedule timers that stop on `deactivate`, and each returns a function that cancels its timer; `scope.signal` aborts on `deactivate`. Errors thrown by timer tasks and event handlers are logged; they do not crash the device.

Data that crosses the backplane must survive `structuredClone`: no functions, no class instances. It is copied, unless you move or share binary data as [Binary data](#binary-data) describes. Throw `new RackError(code, message, data?)` to give callers a code they can branch on. Device codes must not start with `RACK_`, and any other exception reaches the caller as `RACK_DEVICE_FAULT`.

Each Worker receives a copy of `process.env` as it is when the Worker starts.

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

## The rack manifest

A manifest names the device file in each slot. It never imports device code; the rack loads devices by path.

```ts
// rack.ts
import { rack, slot } from "rack42u";
import { memkv } from "rack42u/std";

export default rack("hello", {
  slots: {
    1: memkv(),
    3: slot("./devices/greeter.ts", { config: { prefix: "Hello," } }),
    4: slot("./devices/web.ts"),
  },
  panel: { http: { port: 3000, routes: { "/greet": "web.http" } } },
});
```

The `web` device is defined under [HTTP panel](#http-panel).

- Relative device paths resolve against the rack base directory, which for `rack start` and `rack dev` is the manifest's directory.
- A device's name defaults to its model. Give devices that share a model distinct names with `slot(path, { name })`.
- Each need is wired to the only port with the same connector id among the devices below it. When there are several, add a patch: `patch: [["greeter.cache", "memkv.kv"]]`.
- The rack refuses to start when slots overlap, a device does not fit, two devices share a name, a need has no provider below it or more than one, or a patch or panel route names something that does not exist.

## Scanned racks

Instead of placing every device by hand, a manifest can name the directories that hold device files, and let the rack work out the instances, their wiring, and their slots:

```ts
// A scanned manifest: slots and patches are worked out from the device files.
import { rack } from "rack42u";
import { sqlite } from "rack42u/std";

export default rack("app", {
  devices: ["./devices", sqlite({ path: "data/app.db" })],
  roots: ["a", "b", "c"],
  panel: { http: { port: 3000, routes: { "/api/*": "a.http" } } },
});
```

- **`devices`** lists directories and specs.
  - Every `.ts`, `.tsx`, `.js`, and `.mjs` file below a directory, at any depth, must default-export a device. Files and folders whose names start with `_` or `.` are skipped, and so is `node_modules`.
  - A `slot()` or standard-device spec adds one file, and its `config` becomes that model's default. A `name` in it defines a variant: the same file under another model name.
- **`roots`** names the models the rack starts on its own; a panel route that names a model adds it. Everything else starts only when something needs it.

A need either shares its provider or owns a copy of it:

```ts
// In devices/a.ts: a owns a copy of d and a copy of f.
needs: { d: own(D), f: own(F) },
// In devices/c.ts: c shares e with every device that shares it, and owns a copy of f.
needs: { e: E, f: own(F) },
```

Each model has one shared instance, named after the model, and each `own` need gets a copy named `<consumer>-<need>`. With the roots `a`, `b`, and `c`, and `b` needing `E` as well, the plan is:

| Slot | Instance | Serves |
|---|---|---|
| U1 | `a-d` | `a` only |
| U2 | `a-f` | `a` only |
| U3 | `c-f` | `c` only |
| U4 | `e` | `b` and `c` |
| U5 | `a` | root |
| U6 | `b` | root |
| U7 | `c` | root |

- **Order:** every instance sits above what it needs, so the rack starts bottom up and stops top down as usual. Where the dependency graph leaves the order open, a higher `priority` in the device file goes first. Priority is an integer that defaults to 0, and a device passes it down to what it needs. Layers, then names, settle the rest.
- **Cycles:** a cycle fails at startup with its path, for example `cycle: a.d → a-d.back → a`. The usual fix applies: the lower device emits events, and the upper one subscribes to them.
- **Several providers:** when several models provide a need's connector, `use` picks one, for example `use: { "kv/v1": "memkv", "a.cache": "redis" }`. A `<model>.<need>` entry wins over a connector id.
- **Configuration:** `config` gives configuration by instance name or by model, and an instance name wins. A device can also name its own resources after `ctx.slot.name`, so each copy gets its own.
- **Owners:** `status()` reports, for each copy, the `owner` whose `own` need it serves. In a manifest that places devices by hand, an `own` need must be wired to a device that nothing else is wired to.
- **Changes:** a scanned rack's instances come and go with its plan, so `plug`, `unplug`, and `swap` with another file fail with `RACK_SWAP_REJECTED`. `reload()` and `rack dev` hot-swap the instances whose files changed. A change to the plan itself, such as a new need, needs a restart for now.

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
```

On `SIGINT` or `SIGTERM` both commands shut down in order and exit with code 0; a second signal exits at once with code 1. They exit with code 1 when the rack fails to start.

`rack dev` watches the base directory, ignoring `node_modules` and dot directories. After a change it rebuilds every device and swaps the ones whose firmware hash changed, so editing a file that several devices bundle, such as a shared connector, swaps all of them. A device that fails to build keeps running its old firmware. Edits to the manifest itself take effect only after a restart.

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
| `plan` | `true` | How a scanned rack uses its plan file: `true` follows it, `"update"` rewrites it as `rack dev` does, and `false` neither reads nor writes it. |

The handle returned by `start`:

| Method | Purpose |
|---|---|
| `status()` | Each device's slot, height, state, firmware hash, calls in flight, recent crashes, and, for a copy, its `owner`. |
| `call(address, method, input, options?)` | Call a port from outside the rack. |
| `swap(name, source?)` | Replace a device, optionally with another device file. |
| `reload()` | Rebuild all firmware and swap the devices whose hash changed. |
| `plug(u, slot(...))` / `unplug(name)` | Add a device to a free slot, or remove one that nothing uses. |
| `subscribe(listener)` | Receive power, swap, fault, and log events. |
| `metrics()` | Read each device's call and event counters. |
| `stop()` | Shut down from the top down. |

Management operations run one at a time, in the order they were called. Firmware is written to `.rack/firmware/` under the base directory; keep `.rack/` out of version control.

`metrics()` resolves with `{ devices }`, one entry per device whose installed instance answered, bottom slot first. Each entry has the device name, the `firmware` hash of the instance that counted, `since` (when that instance booted), and counters per member:

```js
{
  device: "orders",
  firmware: "7f3a9c…",
  since: 1763260000000,
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
- Counters live in each device's Worker, which keeps them from the moment its instance boots, so they restart when a device swaps or resets. A device that does not answer within `hookTimeout` is left out.

## Hot swap and hot reload

Every swap follows the same sequence:

1. The new firmware boots in a standby instance, and the rack checks that ports other devices or panel routes use still exist with the same connector. If not, the swap is rejected with `RACK_SWAP_REJECTED`.
2. The new instance runs `powerOn` and `selfTest` while the old one keeps serving.
3. The old instance runs `deactivate`. If the device has `snapshot`/`restore`, calls to the slot are held while the old instance finishes its calls, and its snapshot is restored into the new instance.
4. The new instance runs `activate`. Calls to the slot are held for a moment and then switch to it in one step; held calls go to the new instance, and none are lost.
5. The old instance finishes the calls it still holds, runs `powerOff`, and is terminated. Calls still running after `drainTimeout` fail with `RACK_LINK_DOWN`.

If anything in steps 1–4 fails, the new instance is discarded, the old one is reactivated and keeps serving, and the slot reports `degraded`.

When a device crashes (an uncaught exception, an unhandled rejection, or `process.exit`), its calls in flight fail with `RACK_DEVICE_FAULT` and the rack resets it from the same firmware. Calls during the reset fail with `RACK_LINK_DOWN`. In-memory state does not survive a reset, so keep state that matters in a storage device. After more than 3 crashes within 60 seconds, the slot is marked `faulted` until a swap succeeds.

## HTTP panel

`panel.http.routes` maps [Bun route patterns](https://bun.sh/docs/api/http#routing), such as `/orders/:id` and `/api/*`, to ports that implement `http/v1`. Each request goes to the instance installed at that moment, so swaps do not interrupt the server.

`httpHandler` turns a fetch-style function, `(request: Request) => Response | Promise<Response>`, into an `http/v1` implementation:

```ts
// devices/web.ts
import { device, Http, httpHandler } from "rack42u";
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

An `http/v1` call carries the method, URL, headers, route parameters, and body of the request; `httpHandler` hands your function a standard `Request` with the same method, URL, headers, and body. Duplicate response headers, such as several `Set-Cookie` headers, are kept. Bodies are copied in full. When the call fails, the panel answers with a JSON body `{ code, message }` and status 503 for `RACK_LINK_DOWN`, 504 for `RACK_TIMEOUT`, and 502 for anything else. Unmatched paths get 404.

## Standard devices

`rack42u/std` exports the standard connectors and the factories that mount the standard devices.

- **`memkv(options?)`** provides `kv: Kv` (`kv/v1`), an in-memory store of string keys and string values: `get(key)`, `set({ key, value })`, `delete(key)`, `keys(prefix)`, and a `changed` event with the key after every `set` and every `delete` that removed a key. Entries move to the new instance during swaps and hot reloads; a restart starts empty.
- **`sqlite(config, options?)`** provides `sql: Sql` (`sql/v1`) on `bun:sqlite`: `query({ sql, params? })` returns rows as objects, `run({ sql, params? })` returns `{ changes, lastInsertRowid }`, and `batch([...statements])` runs statements in one transaction and rolls back if one fails. Parameters bind to positional `?` placeholders. `config.path` is relative to the base directory, missing directories are created, and file databases use WAL mode; `":memory:"` gives an in-memory database that moves to the new instance during a swap. Database errors fail with `SQL_ERROR`, with the driver's code, such as `SQLITE_CONSTRAINT_UNIQUE`, in `data.code`.

Both factories take `{ name }` in `options` to rename the device.

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
| `RACK_DEVICE_FAULT` | The device threw a non-`RackError` exception, or crashed. |
| `RACK_MANIFEST` | The manifest or the assembly is invalid. |
| `RACK_SWAP_REJECTED` | A swap, plug, unplug, or reload was refused. |
| `RACK_HOOK_FAILED` | A lifecycle hook failed or timed out. |

## Not in P0

- Devices run only as `sled` (one Worker each); the `inline` and `chassis` forms are planned.
- Editing the manifest of a running rack: restart the rack instead.
- Swapping several devices as one batch, or changing a connector's major version without a restart.
- A WebSocket panel, streaming HTTP bodies, circuit breakers, rate limiting, watchdogs for hung devices, and a management dashboard.
- Connecting several racks, and packaging a rack with `bun build --compile`.

## Development

| Purpose | Command |
|---|---|
| Run all tests | `bun test` |
| Type check | `bun run typecheck` |
| Lint and format check | `bun run lint` |
| Check decision records | `bun run check:decisions` |
| All of the above | `bun run check` |

Design decisions live in [`.agents/decisions/`](.agents/decisions); [`AGENTS.md`](AGENTS.md) explains how the project is run.

## License

[MIT](LICENSE)
