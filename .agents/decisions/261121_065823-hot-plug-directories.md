# Decision: Hot-plug directories, whose devices come and go with their files, and the contracts through which hosts reach them

Status: accepted

## Background

- The user on 2026-11-21, after asking whether rack42u loads devices without slots: "If a devices folder is used for automatic plugin loading, is that scenario supported?" Then: "Draft it. I think one approach is to allow certain directories to be designated as locations for plugin scanning and loading. As for executables, I don't think they need to be covered. What I need is the plugin approach that best fits rack42u as it currently stands."
- On the first draft, the user's answers: "1. Call it hotplug. 2. Plugins also need to be monitored for changes. 3. Also, there is another issue with plugins: how they are invoked—for example, registering some hooks and providing some calls—needs to be able to hook in, and devices that support plugins need to discover the calls they provide. All of this needs careful consideration."
- A scanned rack, as [Automatic assembly from scanned device files](261116_233919-automatic-assembly.md) decides, builds every file of its `devices` directories, and starts its roots and what they need. On 2026-11-21, a file that nothing needed stayed off, and only `rack plan` named it, as `# unused models: time`; with no roots, the plan held nothing. That leaves these gaps for plugins:
  - A file starts only as a root or when something needs it, and a root must name a model whose file is there. So the manifest names each plugin, and can't name one before its file comes.
  - A file that fails to build, or that isn't a device, fails assembly, so one broken plugin keeps the whole rack from starting.
  - A need is wired to one provider, so no device reaches every plugin.
  - The plan file binds `rack start`, so that "a layout that nobody reviewed never starts": each new plugin would wait for `rack plan --write`.
  - A device passes its priority down to what it needs, so a plugin could reorder the devices that it uses.
  - An executable scans only the files that it packaged, and its outside files add no devices, as [A rack in one executable](261120_011627-single-executables.md#devices-from-outside-files) decides.
- Changes while a rack runs: `rack dev` watches the whole base directory, applies edited manifests, and rewrites the plan file. `rack start` applies changes at `rack ctl reload`. [Executables that apply changed device files on command, or as they change with --watch](261120_221450-watching-outside-files.md#alternatives) turned down `--watch` for `rack start`, which would apply every changed device file, "since `rack dev` is that".
- Calls between devices: functions don't cross the backplane, so a device can't hand another one a callback. What a device provides, it declares in its file, and the rack reads that from its firmware. Connectors carry Standard Schema objects, which validate data in the Worker of the provider.
- The [gravity rule](261112_035942-rack-architecture.md#gravity-rule): a device depends only on devices below it, and a lower device reaches an upper one through events. The HTTP panel sits above the devices that it routes to.
- The glossary of `AGENTS.md` calls no device a plugin. This decision names the devices that the user calls plugins after the rack's own word: hot-plug devices, which are plugged into a running rack, and unplugged, as their files come and go. A device that reaches them is their host.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - extensibility: an app gains a capability when a device file is put in a directory, without an edit of its manifest, and the app's hosts find what it offers;
  - reliability: a hot-plug device that fails is left out, and its faults stay in it, while the devices that the plan file records run as before;
  - observability: the log, `status()`, and `rack plan` say which hot-plug devices run, and why others don't;
  - maintainability: hot-plug devices go through the scan, the plan, the reload, the swap, and the watcher that exist, and the gravity rule stays whole.

## Evidence

- [Standard JSON Schema](https://standardschema.dev/json-schema), read on 2026-11-21, is a versioned v1 interface from the maintainers of Zod, Valibot, and ArkType: a schema that implements it gives JSON Schemas of its input and output through `schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })` and `.output(...)`, which may throw for a schema that has none. Zod 4.2 and later and ArkType 2.1.28 and later build it in; Valibot 1.2 gives it through `toStandardJsonSchema()` of `@valibot/to-json-schema` 1.5 and later.
- rack42u's development dependencies hold Zod 4.6.7, and its dependencies Valibot 1.5.0 and `@standard-schema/spec` 1.1.0. `src/schema.ts` validates through the `~standard` interface, not through a library.

## Decision

### An example

```ts
// devices/tools.ts: the host, which lists the commands of its hot-plug devices and runs them
import { device, every } from "rack42u";
import { Commands, Http, httpHandler } from "rack42u/std";

export default device({
  model: "tools",
  needs: { commands: every(Commands) },
  provides: { http: Http },
  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const [, , name = "", command = ""] = new URL(request.url).pathname.split("/");
      const devices = ctx.ports.commands;
      if (name === "") {
        // GET /tools: each device with its commands.
        const entries = devices.list().map(async (entry) => ({
          device: entry.name,
          commands: await devices.get(entry.name)?.list(undefined),
        }));
        return Response.json(await Promise.all(entries));
      }
      // POST /tools/<device>/<command>: runs the command with the JSON of the body.
      const port = devices.get(name);
      if (port === undefined) return new Response("no such device\n", { status: 404 });
      return Response.json(await port.run({ name: command, input: await request.json() }));
    }),
  }),
});
```

```ts
// plugins/upper.ts: a hot-plug device, which runs once its file is there
import { device } from "rack42u";
import { Commands, commands } from "rack42u/std";
import * as z from "zod";

export default device({
  model: "upper",
  provides: { commands: Commands },
  powerOn: () => ({
    commands: commands({
      upper: {
        description: "Upper-cases a text",
        input: z.object({ text: z.string() }),
        output: z.string(),
        run: ({ text }) => text.toUpperCase(),
      },
    }),
  }),
});
```

```ts
// rack.ts
import { rack } from "rack42u";
import { httpPanel } from "rack42u/std";

export default rack("app", {
  devices: [
    "./devices",
    httpPanel({ port: 3000, routes: { "/tools": "tools.http", "/tools/*": "tools.http" } }),
  ],
  hotplug: ["./plugins"],
  roots: ["http-panel"],
});
```

With `plugins/lower.ts` and `plugins/upper.ts`, the rack runs:

| Slot | Instance | In `app.plan` |
|---|---|---|
| U1 | `lower` | no: a hot-plug device |
| U2 | `upper` | no: a hot-plug device |
| U3 | `tools` | at U1 |
| U4 | `http-panel` | at U2 |

- `curl localhost:3000/tools` lists both devices, with the name, the description, and the JSON Schemas of each command.
- `curl -d '{"text":"hi"}' localhost:3000/tools/upper/upper` answers `"HI"`.
- Under `rack start` and `rack dev` alike, a file saved in `plugins/` runs after the reload that it starts, and the device of a file removed from it is unplugged. `app.plan` stays as it is.

### Hot-plug directories

- `hotplug` lists directories of a scanned manifest, relative to the base directory. Each device file in them, found as in a `devices` directory, is a **hot-plug device**: it starts on its own, without being a root.
- A hot-plug directory lies inside the base directory, and neither lies in a `devices` directory nor holds one. Otherwise the manifest fails with `RACK_MANIFEST`. A hot-plug directory that doesn't exist holds no devices.
- **Fixed instances** are the others: the roots, and what they need. Hot-plug devices leave them as they are:
  - A hot-plug device's needs are met by fixed instances, among which `use` picks by connector id. It starts no shared instance.
  - Its `own` needs get copies of models that `devices` gives. The copies belong to it: they are hot-plug instances too, and come and go with it.
  - Its priority orders it among the hot-plug devices at the same place, and passes nothing down.
  - It has no every need of its own.
- Only every needs reach hot-plug devices. No other need is wired to one, and the manifest names none: a hot-plug model in `roots`, `use`, `patched()`, or a route fails the manifest with `RACK_MANIFEST`. `config` may name a hot-plug model, for when its file comes.
- A hot-plug model's name differs from every fixed model's, and from every other hot-plug model's.

### Every needs

- `every(connector)` declares a need for every device below that provides the connector, by name:

  ```ts
  needs: { commands: every(Commands) },
  ```

- **Placed by hand**, it reaches every device below its own that provides the connector, and follows `plug()` and `unplug()` below it.
- **Scanned**, the plan places every fixed instance that provides the connector below the device, as for a need, and the hot-plug devices too, as [Where hot-plug devices go](#where-hot-plug-devices-go) describes. It starts nothing: it reaches what runs for other reasons. An instance that provides the connector and needs the device, directly or indirectly, is a cycle.
- It doesn't reach copies that serve an `own` need, or a device that provides the connector on several ports, which the log warns about. `patch` and `use` don't apply to it, and naming one fails with `RACK_MANIFEST`.
- In the device:

  | Member | Purpose |
  |---|---|
  | `ctx.ports.<need>.list()` | The devices that it reaches now, in slot order from the bottom, each as `{ name, model, firmware, hotplug }`. |
  | `ctx.ports.<need>.get(name)` | The port of that device, called as a need's port is, or `undefined` while the need doesn't reach it. |
  | `ctx.ports.<need>.changed(handler)` | Calls `handler(list)` after each change of what it reaches: a device that comes, one that goes, and one that runs other firmware, after a swap or a fallback. Returns a function that stops it. |
  | `ctx.on.<need>.<event>((payload, from) => ...)` | An event from any device that it reaches, now or later, with the name of the device that emitted it. |

- A port from `get(name)` calls the device of that name when each call starts. A call fails with `RACK_LINK_DOWN` while the need doesn't reach a device of that name, as for a provider that is offline. While that device swaps, its calls wait, as for any need, and the calls to the others go on.
- A `changed()` handler runs as an event handler does: what it throws is logged, and the device goes on.
- `queueLimit` bounds the calls to each device that it reaches, as for one need. `metrics()` counts its calls and events as those of one need.
- On the bench, the stubs of an every need are given by device name: `needs: { commands: { upper: stub(Commands, { list: () => [] }) } }`.

### How hot-plug devices hook in

- **Contracts are connectors.** An app that takes hot-plug devices defines its extension points as connectors, which its hot-plug devices import, as any device imports connectors.
  - A device hooks into an extension point by providing a port of its connector. That is its registration: declared in its file, and read by the rack from its firmware when the rack plugs the device in, at the reload that the file starts, while the rest of the rack runs. No device registers by a call, such as `host.register(...)`, since functions don't cross the backplane.
  - A device provides only the extension points that it implements. Members that a device implements together belong in one connector, and extension points that devices take one by one belong in connectors of their own.
- **The host calls them.** A host reaches each extension point with an every need, and calls the devices of `list()` in its order, or in an order of its own. The host decides how:
  - to notify: each device, in turn or at once, without a result;
  - in a pipeline: in turn, each with the output of the one before;
  - for an answer: in turn, until one answers.

  A hot-plug device's `priority` sets where it comes in that order, among the hot-plug devices at its place. The host gives each call a timeout, and treats a call that fails as the failure of that device: it skips the device, or reports the error, as its contract says. A device that hangs costs one call's timeout, and the host goes on:

  ```ts
  for (const { name } of ctx.ports.decoders.list()) {
    try {
      const text = await ctx.ports.decoders.get(name)?.decode(bytes, { timeout: 500 });
      if (text !== null && text !== undefined) return text;
    } catch (error) {
      ctx.log.warn("a decoder failed", { device: name, code: (error as RackError).code });
    }
  }
  ```

- **They hook into the app's services through events.** A hot-plug device subscribes to the events of the fixed instances below it, as any device does, such as the `received` event of a device that holds the app's sessions.
- **They offer calls, which hosts discover.**
  - Calls that the host knows ahead are members of an extension point's connector.
  - Calls that each device has of its own go through `commands/v1`, as [The commands connector](#the-commands-connector) describes.
  - A host discovers them in two steps: its every need's `list()` gives the devices that offer them, and each device's own `list()` gives its commands. After `changed()`, the host asks again the devices that came, or whose firmware changed.
- **They call the app through the devices below them.** A hot-plug device sits below its host, and can't call it. It calls the services that the app places below its hot-plug devices, such as sessions, storage, or settings, and reports to its host through events on its ports, which the host's every need receives with its name.
- **They keep state as any device does**: in memory, across swaps with `snapshot` and `restore`; in a storage device below; or in an `own` copy of one.

### The commands connector

`rack42u/std` gives `Commands`, the connector `commands/v1`, and `commands()`, which implements it from a table of commands:

| Member | What it does |
|---|---|
| `list(undefined)` | The device's commands, each as `{ name, title?, description?, input?, output? }`, where `input` and `output` are JSON Schemas of draft 2020-12. |
| `run({ name, input })` | Runs one command with its input, and answers with its output. |

- `commands({ <name>: { title?, description?, input, output?, run } })` takes Standard Schema objects for `input` and `output`. Its `run(input, call)` gets the input that the schema gave, and the call, with its signal.
- `list()` gives a JSON Schema for each schema that implements Standard JSON Schema. A schema that doesn't, or whose conversion throws, gets none, and the command runs all the same.
- `run()` validates the input, and the output when there is a schema for it. A name that the device doesn't offer fails with `RACK_NO_ROUTE`, input that fails its schema with `RACK_INVALID_INPUT`, and output that fails its schema with `RACK_INVALID_OUTPUT`, each with the issues in its data.
- A device's commands stay the same while its instance runs. New commands come with new firmware, which `changed()` reports to the hosts.
- Commands take and give data that crosses the backplane. A command that streams bytes is a member of a connector of its own.

### Where hot-plug devices go

- A hot-plug device, with its copies, takes the slots directly below the lowest fixed instance that has an every need for a connector that it provides, or the slots above the top fixed instance when none has. Its copies sit directly below it.
- It must sit above every fixed instance that it needs, or it is left out.
- Hot-plug devices at the same place go in order of priority, highest first, then of name.
- The fixed instances above a hot-plug device move up by its height. Moving changes only slot numbers, as [Applying a changed plan](261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan) says.

### The plan file

- In a rack with hot-plug directories, the plan file records the fixed instances alone, at the slots that they take without hot-plug devices. It binds their order and wiring, as [Plan file](261116_233919-automatic-assembly.md#plan-file) decides.
- For such racks, this replaces the rule that `rack start` follows the file's slots as written: the hot-plug devices move them up.
- So hot-plug devices come and go without a change of the file, under `rack dev` too. Nobody reviews them in it, and `rack plan --check` and `--write` ignore them.

### When changes apply

- At start, and at each `reload()`, which `rack ctl reload` calls, the rack scans the hot-plug directories and builds their files again. It applies the changes as [Applying a changed plan](261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan) describes: it plugs the devices whose files came, replaces those whose firmware changed, and unplugs those whose files went.
- The every needs above a hot-plug device reach it once it is online, and stop reaching it before it is unplugged.
- Nothing restarts for a hot-plug device: the rack plugs, swaps, or unplugs it alone, while its hosts, the other hot-plug devices, and the fixed instances keep running and serving. Only slot numbers move.
- An extension point that a host doesn't know yet comes with a new version of the host, which replaces the host as any change of a fixed device's file does, without a restart.
- An edited manifest that adds or removes a hot-plug directory applies under `rack dev`, as other edits do, and takes a restart under `rack start`, which doesn't read an edited manifest, as now.
- **`rack start` watches the hot-plug directories**, with the watcher of `rack dev`, and the reload that a change starts applies the hot-plug devices' changes alone:
  - The files that count are device files and JSON, as for an executable with `--watch`, inside a hot-plug directory.
  - The fixed instances change at `rack ctl reload`, as now. This is not the `--watch` that the watching decision turned down, which would apply every changed device file.
- `rack dev` applies hot-plug changes with the rest, from its watcher of the whole base directory, as now.
- `start()` doesn't watch: its caller applies changes with `reload()`, so that what `reload()` reports stays the caller's to know.
- Under `rack start`, a `reload()` that the plan file refuses, for a changed fixed plan, applies nothing, as now. The watch's reloads look at the hot-plug devices alone, so that a changed fixed plan doesn't stop them.

### Failures

A file that is left out runs no instance, and the log says why, as [Observation](#observation) describes.

| Failure | Outcome |
|---|---|
| A file in a hot-plug directory doesn't build, or doesn't default-export a device | The file is left out, and the rest of the rack starts or reloads. |
| Its model is a fixed model's, or another hot-plug file's | It is left out. Two hot-plug files of one model both are. |
| It has a need that no fixed instance meets, or that several meet while `use` picks none | It is left out. |
| It has an every need, a configuration that fails its schema, or a place that it can't take | It is left out. |
| The rack has no room for it | The hot-plug devices that come last in the order of placement are left out. |
| `powerOn`, `selfTest`, or `activate` fails, at start or when it is plugged | It is ended and left out, with its copies. At start, its slots stay empty until the next reload, and the rack starts without it, since no fixed instance needs it. |
| It crashes or hangs | It is reset, as any device is, and faulted after 3 crashes within the crash window, until a swap succeeds. Calls to it fail with `RACK_LINK_DOWN`, and calls to the other devices of an every need go on. |
| It is slow | Calls to it reach `queueLimit` and fail with `RACK_OVERLOADED`, while each other device of an every need has its own bound. A host's timeout ends each call that waits too long. |
| Its file changes, and the new version can't run | The running instance keeps its firmware, `degraded`, as any device does at a failed reload. |
| Its file is removed, or its directory is | It is unplugged. The every needs stop reaching it first, and its calls in flight finish, or fail with `RACK_LINK_DOWN` after `drainTimeout`. |
| A file is still being written when the watch's reload reads it | It fails to build and is left out, or its running instance keeps its firmware. The write that ends starts another reload. |
| The watch of `rack start` can't start, or its base directory is removed | As for `rack dev`: the log errors, the rack runs on, and hot-plug changes apply at `rack ctl reload`. |
| A device provides an every need's connector on several ports | The need doesn't reach it, and the log warns. |
| No device provides an every need's connector | The need reaches none, and `list()` is empty. That is no failure. |
| A `changed()` handler throws | The log has the error, and the device goes on. |
| A command's name, input, or output is wrong | `run()` fails with `RACK_NO_ROUTE`, `RACK_INVALID_INPUT`, or `RACK_INVALID_OUTPUT`. |
| `commands()` gets more than 256 commands, or a name that isn't one | It throws `RACK_INVALID_INPUT`, so the device fails to power on, and a hot-plug device is left out. |
| A hot-plug directory outside the base directory, or one that overlaps a `devices` directory; a hot-plug model that the manifest names; `patch` or `use` for an every need | The manifest fails with `RACK_MANIFEST`. |
| `rack compile` of a manifest with `hotplug` | It fails with `RACK_MANIFEST`. |

### Bounds

| What | Bound |
|---|---|
| Hot-plug devices | The rack's `size`, 42U by default, less what the fixed instances take |
| Devices that an every need reaches | Those below its device, fewer than the rack's `size` |
| Calls that wait for one device of an every need | `queueLimit`, as for one need |
| `changed()` calls | One per change of what the need reaches |
| Commands of one device | 256, each named with 1 to 64 letters, digits, `.`, `_`, and `-`, from a letter |
| Builds per start or reload | One per device file, hot-plug files included, as now |
| The watch of `rack start` | As for `rack dev`: two watches, 100 ms after the last change and at most 1 s after the first, and one reload at a time with one more waiting |
| Log entries about a file that is left out | One at each start, and one when the file or the reason changes |

### Observation

- At start, the log gives each hot-plug directory with the number of its device files, and says so when a directory doesn't exist, so that a mistyped path shows. Under `rack start`, it says `watching the hot-plug directories for changes`.
- The log warns `<path> left out: <reason>`, with the code, at each start, and at a reload when the file or the reason changed. Plugging, swapping, and unplugging a hot-plug device log as for any device.
- `status()` gives `hotplug: true` for hot-plug devices and their copies.
- `rack plan` prints, after the plan, each hot-plug device with the slots that it would take, such as `# hot-plug U1 lower lower -`, and each file that is left out, such as `# left out plugins/broken.ts: <reason>`.
- `reload()` reports a hot-plug device that fails to plug, as it reports any step that fails. `history()` and `metrics()` cover hot-plug devices as any.

### Executables and security

- `rack compile` refuses `hotplug`, since executables are out of scope, as the user said. Every needs and `commands/v1` work in executables, which package the devices that they reach.
- Whoever can write a hot-plug directory runs code as the rack's user: under `rack start` and `rack dev`, at once. That holds for `devices` and `node_modules` already, from the next start or reload.
- A hot-plug device runs in a Worker of the rack's process, as every device does. The Worker contains its faults, not its access.

### Tests

- A fixture app with a host, hot-plug devices, the services below them, and the HTTP panel, under `start()`, `rack dev`, and `rack start`:
  - The devices of the hot-plug directory start without roots, below the host, which lists them and calls each by name. The plan file records the fixed instances alone, and `status()` marks the hot-plug devices.
  - Under `rack start` and `rack dev`, a file saved in the directory runs, a changed one is swapped, and a removed one is unplugged, while the host keeps answering for the others. The plan file stays as it is.
  - Under `rack start`, a fixed device's file changed at the same time waits for `rack ctl reload`, and a changed fixed plan doesn't stop the watch's reloads.
  - Each failure of the table leaves its file out, with its log entry, while the rest starts or reloads. The file runs at the reload after it is fixed.
  - A hot-plug device that crashes, hangs, or is slow fails only the calls to it.
- Every needs, in racks placed by hand and scanned: what they reach, in slot order and by priority among hot-plug devices; `plug()` and `unplug()` below; a device above, which they don't reach; a cycle; `changed()` for a device that comes, goes, and swaps, and one that throws; events, with the name of the device that emitted them; a swap that holds only the calls to the swapped device; and the bench's stubs by name.
- `commands()`: the list, with JSON Schemas from Zod and none for a schema without Standard JSON Schema, and `run()` with a wrong name, input, and output, and the bounds.
- `rack compile` refuses `hotplug`.
- The guides' tests run the example above, and the host that calls its devices in turn.

### Dependencies

None. Standard JSON Schema is an interface that `commands()` checks for; the tests use Zod, which is a development dependency already.

## Alternatives

- **Roots that name directories**, such as `roots: ["./plugins"]`: one field fewer, but a broken file would still fail assembly, a new file would still change the plan file, and nothing would reach the devices.
- **An every need that starts every provider**, as a need starts its provider: `every(Http)` would start every HTTP device that `devices` holds. What starts is what roots, needs, and hot-plug directories decide.
- **Every needs that ignore the gravity rule**, so that hot-plug devices sit above their host and can call it: the fixed slots would stay as written, but a hard constraint would change, and a lower device would call upper ones. A host above its devices is what the HTTP panel already is.
- **Hot-plug devices in the plan file**: each file would change the layout under review, and `rack start` would refuse each new one until `rack plan --write`.
- **Registration at run time**, such as `host.register("decode", handler)`: a function can't cross the backplane, so a device would register a name, and the host would call it through a contract anyway. What a device declares in its file is what the rack plans, reports, and checks.
- **Optional members in connectors**, so that one connector holds every hook, and a device implements some: each port would carry which members it has, and each host would check them. Connectors of their own give that from what the devices provide.
- **A need for any connector, with calls by member name**, which the rack would describe from the connectors' schemas: the rack would wire needs that name no contract, and a host couldn't check what it calls. `commands/v1` gives the same discovery inside one contract.
- **Commands as a pattern that each app defines**: each app would give its descriptions another shape and its own validation. One connector lets hosts and tools share them, and its helper validates every command.
- **Hosts that notify their hot-plug devices through events**: events go up, from a provider to the devices above it, so a host that notifies its devices calls them.
- **`list()` by name**: a host that calls its devices in turn would get no order that a device can set.
- **Polling `list()` instead of `changed()`**: a host that caches what its devices describe would ask them at every use, or miss a swap.
- **Calls by address**, such as `ctx.call("upper.commands", ...)`: no need would declare them, so the plan couldn't place the devices, and the backplane couldn't link them ahead.
- **`plug()` from `rack ctl`**: a scanned rack refuses `plug()`, and nothing would bring a plugged device back after a restart.
- **Routes of the HTTP panel to hot-plug devices by pattern**, such as `/tools/:device/*`: the panel would need every needs first, and a host device does the same now.
- **`--watch` for `rack start`**, which would apply every changed device file: the watching decision turned it down. Watching only the hot-plug directories, and applying only their changes, gives what the user asked for, and leaves the fixed instances to `rack ctl reload`.
- **A watch in `start()`**: what `reload()` reports would depend on whether the watch got there first, for tests and programs alike.
- **Hot-plug directories in executables**: out of scope, at the user's word. They would undo "Outside files replace packaged devices; they add none".
- **A check that only the rack's user can write a hot-plug directory**: `devices` and `node_modules` have none either, and the ACLs of Windows don't map to file modes.

## Impact

- Public API:
  - `hotplug` in scanned manifests;
  - `every()` in `rack42u`, with `ctx.ports.<need>.list()`, `.get()`, and `.changed()`, and event handlers that get the emitter's name;
  - `Commands` and `commands()` in `rack42u/std`;
  - `hotplug` in `status()`;
  - the bench's stubs by name for an every need;
  - `rack plan`'s `# hot-plug` and `# left out` lines, and the log's `left out`.
- [Automatic assembly from scanned device files](261116_233919-automatic-assembly.md) changes in racks with hot-plug directories only: the plan file's slots no longer run as written, and files that fail in a hot-plug directory are left out instead of failing assembly.
- [Executables that apply changed device files on command, or as they change with --watch](261120_221450-watching-outside-files.md) stays as it is. `rack start` watches the hot-plug directories alone, which its alternative of `--watch` for `rack start` didn't cover.
- [A rack in one executable](261120_011627-single-executables.md) stays as it is, and `rack compile` refuses `hotplug`. The hard constraints of `AGENTS.md` stay as they are.
- Code: `src/manifest.ts`, `src/plan.ts`, `src/rack.ts`, `src/backplane.ts`, `src/worker.ts`, `src/device.ts`, `src/protocol.ts`, `src/bench.ts`, `src/compile.ts`, `src/commands.ts` and `src/cli.ts` for the watch of `rack start`, and a new file in `src/std/` for `commands/v1`.
- Documentation:
  - a new guide, Hot-plug devices, for the directories, every needs, extension points, and commands, in the map of `docs/`;
  - every needs in [Devices](../../docs/guides/devices.md), their stubs in [Testing](../../docs/guides/testing.md), and the watch in [Running](../../docs/guides/running.md);
  - `hotplug` in the reports and the limits, the API reference, and the error codes;
  - the README's status, the skill, and the current state in `AGENTS.md`.
- Costs:
  - The backplane and the Worker host keep one link for each device that an every need reaches, and add and drop links as devices come and go.
  - The planner places hot-plug devices around the fixed plan, and leaves out those that it can't place.
  - A host must expect its devices to come and go, and to fail, and must bound what it waits for.
  - An app designs its extension points as connectors, and places below its hot-plug devices the services that they call.
  - A test of devices that come and go under a host runs a rack, since the bench's stubs are given at its start.
- Follow-up work, each with a decision of its own when it is needed: routes of the HTTP panel through every needs; every needs of hot-plug devices; commands that stream; and a device whose commands change while its instance runs.

## Confirmation

- The user accepted this decision on 2026-11-21, after three drafts. On the first, the user answered: "1. Call it hotplug. 2. Plugins also need to be monitored for changes. 3. Also, there is another issue with plugins: how they are invoked—for example, registering some hooks and providing some calls—needs to be able to hook in, and devices that support plugins need to discover the calls they provide. All of this needs careful consideration."
- On the second, the user asked: "I largely agree. My only question is: according to your description, the app defines each extension point as a connector, and there is no runtime registration—does that mean a new plugin still requires restarting the entire rack?" The Agent answered that nothing restarts, since the rack reads a hot-plug device's declarations when it plugs the device in, and the third draft says so in "How hot-plug devices hook in" and "When changes apply".
- The user's words: "Accept, Go ahead".
