# Devices

A device is a module in one file, which the rack runs in a Worker of its own. It provides ports that other devices call, and needs ports of the devices below it.

## A device file

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

## Hooks

Hooks run in this order: `powerOn` → `selfTest` → `activate` ⇄ `deactivate` → `powerOff`. All but `powerOn` are optional, and `powerOn` is optional too when a device provides nothing. Start timers and other background work in `activate`, not in `powerOn`: during a swap the old and the new instance briefly run side by side.

## The context

The first argument of every hook, `ctx`, provides:

| Member | Purpose |
|---|---|
| `ctx.ports.<need>.<method>(input, { timeout?, signal?, transfer?, streamTimeout? })` | Call a needed connector. |
| `ctx.on.<need>.<event>(handler)` | Subscribe to an event; returns an unsubscribe function. |
| `ctx.emit.<port>.<event>(payload)` | Publish an event on a provided port. |
| `ctx.serve(options)` | Open a listener, in `powerOn` only; see [Listeners](listeners.md). |
| `ctx.config` | The configuration, validated by the `config` schema. |
| `ctx.log.debug/info/warn/error(message, data?)` | Log through the rack. |
| `ctx.signal` | Aborts after `powerOff`. |
| `ctx.slot`, `ctx.firmware`, `ctx.baseDir` | `{ name, u }`, the firmware hash, and the rack base directory. |

A helper that takes `ctx` gives it the type `DeviceContext<Needs, Provides, Config>`, from the device's needs, provided ports, and configuration. Declared as constants, they have types to name:

```ts
// In devices/greeter.ts:
const needs = { cache: Kv };
const provides = { greeter: Greeter };
const Config = v.object({ prefix: v.string() });

/** The context of the greeter's hooks, for the helpers that take it. */
type Context = DeviceContext<typeof needs, typeof provides, v.InferOutput<typeof Config>>;

async function greet(ctx: Context, name: string): Promise<string> {
  await ctx.ports.cache.set({ key: "last", value: name });
  await ctx.emit.greeter.greeted({ name });
  return `${ctx.config.prefix} ${name}`;
}

export default device({
  model: "greeter",
  needs,
  provides,
  config: Config,
  powerOn: (ctx) => ({ greeter: { greet: ({ name }) => greet(ctx, name) } }),
});
```

The state that `restore` receives is `unknown`, since an older instance gave it, which may run another version of the device: `restore` checks it with a schema, as the greeter of [A device file](#a-device-file) does.

## Background work

`activate` also receives `scope`. `scope.every(ms, task)` and `scope.after(ms, task)` schedule timers that stop on `deactivate`, and each returns a function that cancels its timer; `scope.signal` aborts on `deactivate`. Errors thrown by timer tasks and event handlers are logged; they do not crash the device. `scope.watchdog(ms, name?)` arms a watchdog for a work loop, as [Hangs and watchdogs](faults.md#hangs-and-watchdogs) describes.

## Data and errors

Data that crosses the backplane must survive `structuredClone`: no functions, no class instances. It is copied, unless you move or share binary data as [Binary data](data.md) describes. Throw `new RackError(code, message, data?)` to give callers a code they can branch on. Device codes must not start with `RACK_`, except `RACK_OVERLOADED` for a limit of the device's own, as [Overload](faults.md#overload) describes. Any other exception reaches the caller as `RACK_DEVICE_FAULT`.

A call through `ctx.ports` that fails rejects with a `RackError`, whether the provider threw it or the rack did, such as `RACK_TIMEOUT`; [Error codes](../reference/errors.md) lists the rack's. It carries the `code`, `message`, and `data` it was thrown with, and `data` is `unknown` until the caller checks it:

```ts
try {
  await ctx.ports.db.run({ sql: "INSERT INTO links (code, url) VALUES (?, ?)", params: [code, url] });
} catch (error) {
  // The sqlite device's SQL_ERROR carries SQLite's own code in its data.
  const data = error instanceof RackError && error.code === "SQL_ERROR" ? error.data : undefined;
  if ((data as { code?: unknown } | undefined)?.code === "SQLITE_CONSTRAINT_UNIQUE") {
    throw new RackError("LINK_TAKEN", `the code ${code} is taken`);
  }
  throw error;
}
```

## The environment

Each Worker receives a copy of `process.env` as it is when the Worker starts.

## Needs from configuration

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
