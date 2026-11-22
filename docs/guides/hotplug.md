# Hot-plug devices

A hot-plug directory holds devices that start on their own, and come and go with their files while the rack runs. A host device reaches them through an every need: it calls the extension points that they provide, and discovers the commands that they offer.

## Hot-plug directories

A scanned manifest names its hot-plug directories in `hotplug`:

```ts
// tools/rack.ts
import { rack } from "racku";
import { httpPanel } from "racku/std";

export default rack("tools", {
  devices: [
    "./devices",
    httpPanel({ port: 3000, routes: { "/tools": "tools.http", "/tools/*": "tools.http" } }),
  ],
  hotplug: ["./plugins"],
  roots: ["http-panel"],
});
```

- **Hot-plug devices.** Each device file in a hot-plug directory, found as in a `devices` directory, is a hot-plug device: it starts on its own, without being a root.
- **Where the directory lies.** A hot-plug directory lies inside the base directory, and overlaps no `devices` directory. Otherwise the manifest, or the start, fails with `RACK_MANIFEST`. A hot-plug directory that doesn't exist holds no devices.
- **Fixed instances** are the others: the roots, and what they need. Hot-plug devices leave them as they are:
  - A hot-plug device's needs are met by the fixed shared instances, among which a `use` entry by connector id picks. It starts no shared instance, so a service for hot-plug devices is a root, or a need of one.
  - Its `own` needs get copies of models that `devices` gives, which belong to it and come and go with it.
  - Its priority orders it among the hot-plug devices at its place, and passes nothing down.
  - It has no every need of its own.
- **Only every needs reach them.** No other need is wired to a hot-plug device, and a hot-plug model in `roots`, `use`, `patched()`, or a route fails the start with `RACK_MANIFEST`. `config` may name a hot-plug model, for when its file comes.
- **Models.** A hot-plug model's name differs from every model of `devices`, and from every other hot-plug model's.
- **Executables.** `rack compile` refuses a manifest with `hotplug`.

## Every needs

`every(connector)` declares a need for every device below that provides the connector, by name:

```ts
needs: { commands: every(Commands), transforms: every(Transform) },
```

| Member | Purpose |
|---|---|
| `ctx.ports.<need>.list()` | The devices that it reaches now, in slot order from the bottom, each as `{ name, model, firmware, hotplug }`. |
| `ctx.ports.<need>.get(name)` | The port of that device, called as a need's port is, or `undefined` while the need doesn't reach it. |
| `ctx.ports.<need>.changed(handler)` | Calls `handler(list)` after a device comes, goes, or runs other firmware. Returns a function that stops it; what the handler throws is logged. |
| `ctx.on.<need>.<event>((payload, from) => ...)` | An event from any device that it reaches, now or later, with the name of the device that emitted it. |

- **Placed by hand,** it reaches every device in a lower slot that provides the connector, and follows `plug()` and `unplug()` below it.
- **Scanned,** the plan places the fixed instances that provide the connector below the device, and the hot-plug devices too. It starts nothing: it reaches what runs for other reasons. An instance that provides the connector and needs the device, directly or indirectly, is a cycle.
- **What it doesn't reach:** copies that serve an `own` need, and a device that provides the connector on several ports, which the log warns about once. `patch` and `use` don't apply to it, and naming one fails with `RACK_MANIFEST`.
- **Calls.** A port from `get(name)` calls the device of that name when each call starts, and a call fails with `RACK_LINK_DOWN` while the need doesn't reach one. While that device swaps, its calls wait, and the calls to the others go on.
- **Bounds.** `queueLimit` bounds the calls to each device that it reaches on its own, and `metrics()` counts the calls and events as those of one need.
- **On the bench,** an every need takes its stubs by device name, as [The bench](testing.md#the-bench) shows.

## Extension points

An app that takes hot-plug devices defines each extension point as a connector, which its hot-plug devices import:

```ts
// tools/connectors.ts
import { connector, rpc } from "racku";
import * as v from "valibot";

/** An extension point: each device that provides it changes a text, one after another. */
export const Transform = connector("tools.transform/v1", {
  apply: rpc(v.string(), v.string()),
});
```

A device hooks into an extension point by providing a port of its connector. That is its registration: declared in its file, and read by the rack when it plugs the device in, while the rest of the rack runs. No device registers with a call, such as `host.register(...)`, since functions don't cross the backplane.

A host reaches each extension point with an every need, and decides how to call the devices: each, in turn or at once, without a result, to notify them; in turn, each with the output of the one before, as a pipeline; or in turn, until one answers. The tools host runs its transforms as a pipeline, and lists and runs the commands of its devices:

```ts
// tools/devices/tools.ts
import { device, every } from "racku";
import { Commands, Http, httpHandler } from "racku/std";
import { Transform } from "../connectors.ts";

export default device({
  model: "tools",
  needs: { commands: every(Commands), transforms: every(Transform) },
  provides: { http: Http },
  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const [, , name = "", command = ""] = new URL(request.url).pathname.split("/");
      if (name === "" && request.method === "POST") {
        // POST /tools: the text through every transform, from the bottom up.
        let text = await request.text();
        for (const transform of ctx.ports.transforms.list()) {
          const port = ctx.ports.transforms.get(transform.name);
          try {
            text = (await port?.apply(text, { timeout: 1_000 })) ?? text;
          } catch (error) {
            ctx.log.warn("a transform failed", { device: transform.name, error: String(error) });
          }
        }
        return new Response(text);
      }
      if (name === "") {
        // GET /tools: each device with its commands.
        const devices = ctx.ports.commands.list().map(async (entry) => ({
          device: entry.name,
          commands: await ctx.ports.commands.get(entry.name)?.list(undefined),
        }));
        return Response.json(await Promise.all(devices));
      }
      // POST /tools/<device>/<command>: runs the command with the JSON of the body.
      const port = ctx.ports.commands.get(name);
      if (port === undefined) return new Response("no such device\n", { status: 404 });
      return Response.json(await port.run({ name: command, input: await request.json() }));
    }),
  }),
});
```

- **Order.** The devices come in `list()` order, from the bottom: among the hot-plug devices at one place, by priority, highest first, then by name. So a hot-plug device's `priority` sets where it comes in a host's turn.
- **Failures.** The host gives each call a timeout, and treats a call that fails as the failure of that device: it skips the device, or answers with the error, as its contract says. A device that hangs costs one timeout, and the host goes on.
- **Calls from a hot-plug device.** A hot-plug device sits below its host, and can't call it. It calls the services that the app places below its hot-plug devices, and reports to its host through events on its ports, which `ctx.on.<need>` delivers with its name.
- **Events of the app's services.** A hot-plug device also hooks into what those services do through their events, as any device subscribes to the events of the devices below it.
- **One connector or several.** A device provides only the extension points that it implements. Members that devices implement together belong in one connector, and extension points that devices take one by one in connectors of their own.

## Commands

Calls that each device has of its own go through `commands/v1`, the connector `Commands` of `racku/std`. `commands()` implements it from a table of commands:

```ts
// tools/plugins/upper.ts
import { device } from "racku";
import { Commands, commands } from "racku/std";
import * as v from "valibot";
import { Transform } from "../connectors.ts";

export default device({
  model: "upper",
  provides: { commands: Commands, transform: Transform },
  powerOn: () => ({
    commands: commands({
      shout: {
        description: "Upper-cases a text",
        input: v.object({ text: v.string() }),
        run: ({ text }) => text.toUpperCase(),
      },
    }),
    transform: { apply: (text) => text.toUpperCase() },
  }),
});
```

| Member | What it does |
|---|---|
| `list(undefined)` | The device's commands, each as `{ name, title?, description?, input?, output? }`, where `input` and `output` are JSON Schemas of draft 2020-12. |
| `run({ name, input })` | Runs one command with its input, and answers with its output. |

- **JSON Schemas.** `list()` gives a JSON Schema for each schema that implements [Standard JSON Schema](https://standardschema.dev/json-schema), such as Zod's, from version 4.2; Valibot's give one through `toStandardJsonSchema()` of `@valibot/to-json-schema`, a package of its own, which an app adds with `bun add @valibot/to-json-schema`, as in `input: toStandardJsonSchema(v.object({ text: v.string() }))`; the schema still validates. A schema that gives none leaves it out, and the command runs all the same.
- **Validation.** `run()` validates the input, and the output when the command has a schema for it. A name that the device doesn't offer fails with `RACK_NO_ROUTE`, and input or output that fails its schema with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`, with the issues in `data.issues`.
- **Changes.** A device's commands stay the same while its instance runs. New ones come with new firmware, which `changed()` reports to its hosts.
- **Bounds.** `commands()` takes up to 256 commands, each named with 1 to 64 letters, digits, `.`, `_`, and `-`, from a letter. Otherwise it throws `RACK_INVALID_INPUT`, so that the device fails to power on.
- **Discovery.** A host discovers commands in two steps: its every need's `list()` gives the devices, and each device's own `list()` gives its commands. After `changed()`, the host asks again the devices that came, or whose firmware changed.

## Where hot-plug devices go

With `plugins/exclaim.ts`, a transform that adds `!`, next to `plugins/upper.ts`, the tools rack runs:

```ts
// tools/plugins/exclaim.ts
import { device } from "racku";
import { Transform } from "../connectors.ts";

export default device({
  model: "exclaim",
  provides: { transform: Transform },
  powerOn: () => ({ transform: { apply: (text) => `${text}!` } }),
});
```

| Slot | Instance | In `tools.plan` |
|---|---|---|
| U1 | `exclaim` | no: a hot-plug device |
| U2 | `upper` | no: a hot-plug device |
| U3 | `tools` | at U1 |
| U4 | `http-panel` | at U2 |

- **Below the host.** A hot-plug device, with its copies, takes the slots directly below the lowest fixed instance that has an every need for a connector that it provides, or the slots above the top fixed instance when none has. Its copies sit directly below it.
- **Above what it needs.** It sits above every fixed instance that it needs, or it is left out.
- **Slots move.** The fixed instances above a hot-plug device move up by its height, without restarting.
- **The plan file** records the fixed instances alone, at the slots that they take without hot-plug devices, and binds their order and wiring. So hot-plug devices come and go without a change of the file, and `rack plan --check` and `--write` ignore them.

`POST /tools` with `hi` answers `HI!`: `exclaim` runs first, from U1, then `upper`.

## When changes apply

- **At start and at each reload.** At start, and at each `reload()`, which `rack ctl reload` calls, the rack scans the hot-plug directories again. It plugs in the devices whose files came, swaps those whose firmware changed, and unplugs those whose files went.
- **Reaching and leaving.** The every needs above a hot-plug device reach it once it is online, and stop reaching it before it is unplugged. Its calls in flight finish, or fail with `RACK_LINK_DOWN` after `drainTimeout`.
- **`rack start`** watches the hot-plug directories, and a change of a device file or of JSON in them reloads the hot-plug devices alone. The fixed devices change at `rack ctl reload`, as without hot-plug directories.
- **`rack dev`** applies hot-plug changes with the rest, from its watch of the whole base directory.
- **`start()`** doesn't watch: its caller applies changes with `reload()`.
- **Nothing restarts** for a hot-plug device: its host, the other hot-plug devices, and the fixed instances keep running, and only slot numbers move. A new kind of extension point comes with a new version of the host, which replaces the host as any change of a device file does. A hot-plug directory added to the manifest applies under `rack dev`, and takes a restart under `rack start`.

## When a hot-plug device fails

A file that is left out runs no instance, and the log says why, while the rest of the rack starts or reloads.

| Failure | Outcome |
|---|---|
| A file in a hot-plug directory doesn't build, or doesn't default-export a device | The file is left out. |
| Its model is a model of `devices`, or another hot-plug file's | It is left out. Two hot-plug files of one model both are. |
| It has a need that no fixed shared instance meets, or that several meet while `use` picks none | It is left out. |
| It has an every need, or it can't sit above what it needs | It is left out. |
| The rack has no room for it | The hot-plug devices that come last in the order of placement are left out. |
| `powerOn` or `selfTest` fails, or it crashes while the rack starts | It is ended and left out, with its copies, and the rack starts without it. Its slots stay empty until the next reload. |
| It fails to plug at a reload | The reload reports it, and it is left out, with its copies. |
| It crashes or hangs while it runs | It is reset, as any device is. Calls to it fail with `RACK_LINK_DOWN` meanwhile, and calls to the other devices of an every need go on. |
| It is slow | Calls to it reach `queueLimit` and fail with `RACK_OVERLOADED`, while each other device of an every need has its own bound. |
| Its file changes, and the new version doesn't build or load | The running instance keeps its firmware, `degraded`, as any device does at a failed reload. |
| A file is still being written when the watch's reload reads it | It is left out, or its running instance keeps its firmware, until the write that ends starts another reload. |

## Watching hot-plug devices

- **At start,** the log says how many device files each hot-plug directory holds, such as `hot-plug directory plugins/ holds 2 device files`, or that a directory doesn't exist, so that a mistyped path shows. Under `rack start`, it says `watching the hot-plug directories plugins/ for changes`.
- **Files left out:** the log warns `<path> left out: <reason>`, with the code, at start, and at a reload when the file or the reason changed. Plugging, swapping, and unplugging a hot-plug device log as for any device.
- **`status()`** gives `hotplug: true` for hot-plug devices and their copies.
- **`rack plan`** prints, after the plan, each hot-plug device with the slots that it would take, such as `# hot-plug U1 exclaim exclaim -`, and each file that is left out, such as `# left out plugins/broken.ts: <reason>`.

## Trust

<!-- no claims: what the rack doesn't do, which no test can show -->

Whoever can write a hot-plug directory runs code as the rack's user: at once under `rack start` and `rack dev`. That holds for `devices` and `node_modules` already, from the next start or reload. A hot-plug device runs in a Worker of the rack's process, as every device does, which contains its faults, not its access. So a hot-plug directory is writable only by those who may run code as the rack's user.
