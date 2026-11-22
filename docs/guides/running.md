# Running a rack

## The rack command

```sh
rack start [manifest]   # default: rack.ts in the current directory
rack dev [manifest]     # start, then reload devices whose files change
rack plan [manifest]    # print the plan without starting; --write or --check the plan file
rack ctl <operation>    # operate the rack running from this directory
```

On `SIGINT` (Ctrl-C) or `SIGTERM`, and on Windows on `SIGBREAK` (Ctrl-Break), both commands shut down in order. [The rack command](../reference/cli.md) lists their exit codes and flags.

## Running a rack from another program

A program in another language, such as the Rust shell of a desktop app, runs `rack start --stop-on-stdin-close --log json` as a child process, with its standard input a pipe that it keeps open.
- **What it learns from the log:** the `listening` entry of each listener carries `device` and `data.url`, a panel on port 0 included; `rack <name> started` comes once every device is online; and `control listening` carries the endpoint's `address`.
- **Stopping the rack:** the program closes the pipe, which works on every system. When the program ends for any reason, a crash or a kill included, the system closes the pipe, and the rack stops by itself.
- **Waiting:** the shutdown takes as long as the rack's timeouts allow, such as `drainTimeout` and `hookTimeout`. A program that must not wait that long gives the rack a grace period of its own, then kills it.
- **Windows:** a program can start its children in a job object that the system ends together with the program, as `Bun.spawn` does unless the child is detached. A rack started that way ends at once with its program, without its shutdown. Such a program starts the rack detached, with `Bun.spawn`'s `detached: true`.
- The command line's own messages, such as a usage error, are text on stderr.
- **Finding the command:** an app's `rack` command is in its `node_modules/.bin/`, where the scripts of its `package.json` find it. So a program runs a script in the app's directory, such as `bun run start --stop-on-stdin-close --log json` for the `start` script of [Getting started](../getting-started.md#create-the-app): Bun passes the arguments after the script's name on to `rack`. Don't run `bun run rack`: in an app whose manifest is `rack.ts`, Bun runs that file instead of the command, which prints nothing and exits with 0.
- **Configuration:** the manifest is a module, so it can take values from the environment that the program gives the rack, such as `httpPanel({ port: Number(process.env.PORT ?? 3000), routes })`, and read files next to it, such as `new URL("./routes.json", import.meta.url)`.
- **Changing a device while it runs:** under `rack dev`, the rack replaces a device once its file changes, and logs `<device> swapped` once the new firmware serves. Under `rack start`, `rack ctl reload` does it on demand, run through a script too, as [Managing a running rack](managing.md) shows.
- **Shipping the rack with the program:** a program installed where neither Bun nor the app's sources are, such as a desktop app, runs an executable of `rack compile` the same way, with `--base-dir` in a directory of its own, as [A rack in one executable](#a-rack-in-one-executable) describes. The installers of [`examples/net-tool`](../../examples/net-tool) do so, with the executable as a sidecar of their Tauri shell, and `--watch` when the app's user chooses.

A program written in Bun can instead run a rack inside itself with `start()`, with its own `logger`.

## Hot reload with rack dev

`rack dev` watches the base directory, ignoring `node_modules` and dot directories. After a change it rebuilds every device and replaces the ones whose firmware hash changed, so editing a file that several devices bundle, such as a shared connector, replaces all of them. Edits to the manifest itself take effect at once, as [Changed plans and edited manifests](updates.md#changed-plans-and-edited-manifests) describes.

- **When:** a reload starts 100 ms after the last change, and at most 1 s after the first, so that changes that never pause don't hold it off. One reload runs at a time, and the changes made during one start one more after it.
- **Failures:** a device that fails to build keeps running its old firmware, and a reload that fails logs `reload failed`. Watching goes on.
- **A removed base directory:** watching stops, the log errors `stopped watching <dir>: it was removed`, and the rack runs on until it is stopped.
- **A watch that can't start,** such as at the system's limit of watches, logs `cannot watch <dir>`, and the rack runs on; `rack ctl reload` applies changes.

## Hot-plug directories under rack start

`rack start` watches the hot-plug directories of a scanned rack, as [Hot-plug devices](hotplug.md#when-changes-apply) describes, with the watcher of `rack dev`. A change of a device file or of JSON in them reloads the hot-plug devices alone: a new file's device is plugged in, a changed one is swapped, and a removed one is unplugged. The fixed devices change at `rack ctl reload`, and the log says `watching the hot-plug directories plugins/ for changes`.

## Running a rack from code

A program starts a rack with `start()`. This one runs the app that the guides build, the greeter, and calls it twice:

```ts
import { start } from "racku";
import manifest from "./rack.ts";

const running = await start(manifest, { baseDir: import.meta.dir });
await running.call("greeter.greeter", "greet", { name: "Ada" }); // "Hello, Ada"
await fetch("http://localhost:3000/greet?name=Grace").then((r) => r.text()); // "Hello, Grace"
await running.stop();
```

[`start()`](../reference/api.md#start) takes the options, and returns the handle, that the [API reference](../reference/api.md) lists. Management operations run one at a time, in the order they were called. Firmware is written to `.rack/firmware/` under the base directory, and imports racku and the app's packages from there, so the base directory lies inside the app; keep `.rack/` out of version control. The rack gives `.rack/` the mode 0700, also when it exists, since a bundle holds what its device imports, such as a JSON file of secrets; on Windows, `.rack/` keeps the access of the folder that holds it. Each file of firmware is written whole, to a new file renamed into place, and a bundle that is there already is never written again, as is the plan file.

The rack prints its log on the console, one line per entry, unless the `logger` option of `start()` takes the entries: `logger: () => {}` keeps the console quiet, and `logger: (entry) => entries.push(entry)` collects them, so that a check can look for one, such as `<device> swapped`. [The log](../reference/reports.md#the-log) lists what the rack writes.

### A layout that follows data

`reload(manifest)` moves a running rack to another manifest, as [Changed plans and edited manifests](updates.md#changed-plans-and-edited-manifests) describes, so a program can change which devices run as its data changes, such as one device for each entry of a file. The rack tells devices apart by name: a device whose name stays keeps running, even in another slot, unless its firmware or configuration changed. A new name is plugged, and a name that left is unplugged. This program runs one greeter of the guides' app for each language:

```ts
import { rack, slot, start } from "racku";
import { memkv } from "racku/std";

/** One greeter per language, named after its language, above the store they share. */
function layout(greetings: Record<string, string>) {
  const slots: Record<number, ReturnType<typeof slot>> = { 1: memkv() };
  let u = 2;
  for (const [language, prefix] of Object.entries(greetings)) {
    slots[u++] = slot("./devices/greeter.ts", { name: `greeter-${language}`, config: { prefix } });
  }
  return rack("greeters", { slots });
}

const running = await start(layout({ en: "Hello," }), { baseDir: import.meta.dir });

const added = await running.reload(layout({ en: "Hello,", fr: "Bonjour," }));
added.map((result) => `${result.device}: ${result.mode}`); // ["greeter-fr: plug"]
await running.call("greeter-fr.greeter", "greet", { name: "Ada" }); // "Bonjour, Ada"

const removed = await running.reload(layout({ fr: "Bonjour," }));
removed.map((result) => `${result.device}: ${result.mode}`); // ["greeter-en: unplug"]
running.status().map((device) => `${device.name} in U${device.u}`); // ["memkv in U1","greeter-fr in U2"]
await running.stop();
```

- `greeter-fr` moved down to U2 without a restart, so `reload()` reports nothing for it.
- A rack has 42 slots unless its manifest sets more with `size`, such as `rack("greeters", { size: 100, slots })`.
- `rack start` and `rack ctl reload` don't read the manifest again, and `rack dev` reads it again only when the manifest file itself changes, not when a file that it reads does. So a rack whose devices follow a data file runs from a program of its own, such as this one, which also watches the file.

## A rack in one executable

`rack compile` packages a rack into one executable: the manifest, racku, the firmware of every device that the manifest mounts, and the packages that the firmware imports. The executable runs where Bun isn't installed, such as beside the window of a desktop app, and a device in it can still be replaced there by a file:

```sh
rack compile rack.ts --outfile dist/greeter          # about 100 MiB, most of it Bun
./dist/greeter --base-dir /var/lib/greeter           # starts the rack, as rack start does
./dist/greeter ctl status --base-dir /var/lib/greeter
```

- **The base directory** stands for the manifest's directory: the one that `--base-dir` names, or by default the one that holds the executable.
  - The manifest runs when the executable starts, so it reads the environment then, such as a port or a token.
  - Relative paths of the manifest and of devices' configuration, such as the database of `sqlite`, resolve against the base directory.
  - The `import.meta` paths of the manifest and of the app's device files name their places under it, so a device reads a file next to its source from there. A file that must travel inside the executable is imported instead, such as `import routes from "./routes.json"`.
  - The rack itself writes there only the firmware of outside files, in `.rack/firmware/`.
- **Outside files.** Each device file of the app, outside `node_modules`, has an outside file: the file at the same path under the base directory, such as `devices/greeter.ts`.
  - When the rack starts, and at each `reload()` and `swap(name)`, a device runs its outside file when there is one, and its packaged firmware otherwise.
  - racku's own devices, and devices from other packages, run only from their packaged firmware. Outside files replace packaged devices; they add none.
  - The executable builds an outside file as `rack compile` built the packaged firmware: its firmware imports racku, and the packages that the packaged firmware imports, from the executable. Any other import must resolve from the file's place, and its firmware bundles it.
- **On command, or as files change.** While the rack runs, a changed outside file applies at `ctl reload`, or at `ctl swap <device>`. With `--watch`, it also applies as it changes: the executable watches its base directory, and reloads the rack as `ctl reload` does, when and with the bounds that [Hot reload with rack dev](#hot-reload-with-rack-dev) describes.
  - A change counts when the file's name ends in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, or `.json`, outside `node_modules`, and outside files and directories whose names start with a dot, such as `.rack/` and `.env`. So the data that devices keep in the base directory, such as a database, starts no reloads. A device that writes code or JSON there keeps it in a directory whose name starts with a dot.
  - A change to another kind of file that firmware imports, such as `.txt`, applies at the next `ctl reload`.
  - A file that fails at a watched reload, such as one still being written, is a failed swap, as at `ctl reload`; the change that ends the write starts another reload.
  - The program that runs the executable picks one way or the other at each start, such as a service manager, or the shell of a desktop app from a setting of its user.
- **Falling back.** An outside file counts as an update of its packaged device, and the packaged firmware is the device's first known-good firmware, as [Fallback](updates.md#fallback) describes.
  - A device that starts from an outside file starts on probation. Once it gets through probation, its firmware is known-good.
  - When the outside file fails to build, with `RACK_SWAP_REJECTED`, or to load, to boot, to be wired, or its `selfTest`, the device starts from its packaged firmware instead, and its slot reports `degraded`, with the failure as its `error`.
  - When it crashes, or a watchdog bites, on probation, the device falls back to its known-good firmware. Outside files wired to one another fall back together.
  - At `reload()` or `swap(name)`, an outside file that fails to build is a failed swap: the device keeps what it runs.
- **Reports.** `status()` marks a device that runs its packaged firmware with `packaged: true`, and its `source` names the place of its outside file, whether or not the file is there. The log says `<device> runs <file>` for each outside file at start, and warns `<device> runs its packaged firmware: <reason>` at each fallback. `history()` records each fallback with the cause `fallback`.
- **Who can change it.**
  - Outside files run with the rights of the executable: whoever can write the base directory can run code in the rack, as whoever can write an app's files can under `rack start`. With `--watch`, such a file runs at once, not at the next `ctl reload` or start.
  - Unlike `bun`, the executable reads neither a `.env` file nor a `bunfig.toml` in the directory where it starts: a `.env` there could set its control token, and a `bunfig.toml`'s `preload` would run code in the rack. Its environment comes from the program that starts it, such as a service manager, a shell, or the shell of a desktop app.
  - A package that an outside file imports, which the executable doesn't carry, must come from inside the base directory, such as from its own `node_modules`. One that resolves above it, such as to `C:\node_modules` on Windows, which any user can create, fails the file's build, and its device starts from its packaged firmware, as the log says.
  - An outside file whose imports include a macro fails to build, as under `rack start`.
- [The command line of an executable](../reference/cli.md#the-command-line-of-an-executable) lists its flags, and [Flags of rack compile](../reference/cli.md#flags-of-rack-compile) how to compile for another system.

## Windows

racku runs on Windows as it does on Linux and macOS, with these differences:

- **Stopping.** Ctrl-C and Ctrl-Break stop `rack start` and `rack dev` in order, as `rack ctl stop` does. Windows has no `SIGTERM`. A process ended from outside, such as by Task Manager or `taskkill /F`, ends at once, as with `SIGKILL` elsewhere. Closing its console window ends the rack without an orderly shutdown, as a hangup does elsewhere.
- **The management endpoint** listens on loopback TCP with a token, since Windows has no Unix sockets. See [Managing a running rack](managing.md).
- **The control file.** Windows has no file modes: the control file is as private as `%LOCALAPPDATA%`, the local application data folder of your user profile.
- **Paths.** The rack reports paths with `\`, such as `source` in `status()`. Manifests may write relative paths with `/` on every system.
