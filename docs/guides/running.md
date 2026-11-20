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

A program written in Bun can instead run a rack inside itself with `start()`, with its own `logger`.

## Hot reload with rack dev

`rack dev` watches the base directory, ignoring `node_modules` and dot directories. After a change it rebuilds every device and replaces the ones whose firmware hash changed, so editing a file that several devices bundle, such as a shared connector, replaces all of them. A device that fails to build keeps running its old firmware. Edits to the manifest itself take effect at once, as [Changed plans and edited manifests](updates.md#changed-plans-and-edited-manifests) describes.

## Running a rack from code

A program starts a rack with `start()`. This one runs the app that the guides build, the greeter, and calls it twice:

```ts
import { start } from "rack42u";
import manifest from "./rack.ts";

const running = await start(manifest, { baseDir: import.meta.dir });
await running.call("greeter.greeter", "greet", { name: "Ada" }); // "Hello, Ada"
await fetch("http://localhost:3000/greet?name=Grace").then((r) => r.text()); // "Hello, Grace"
await running.stop();
```

[`start()`](../reference/api.md#start) takes the options, and returns the handle, that the [API reference](../reference/api.md) lists. Management operations run one at a time, in the order they were called. Firmware is written to `.rack/firmware/` under the base directory; keep `.rack/` out of version control.

### A layout that follows data

`reload(manifest)` moves a running rack to another manifest, as [Changed plans and edited manifests](updates.md#changed-plans-and-edited-manifests) describes, so a program can change which devices run as its data changes, such as one device for each entry of a file. The rack tells devices apart by name: a device whose name stays keeps running, even in another slot, unless its firmware or configuration changed. A new name is plugged, and a name that left is unplugged. This program runs one greeter of the guides' app for each language:

```ts
import { rack, slot, start } from "rack42u";
import { memkv } from "rack42u/std";

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

## Windows

rack42u runs on Windows as it does on Linux and macOS, with these differences:

- **Stopping.** Ctrl-C and Ctrl-Break stop `rack start` and `rack dev` in order, as `rack ctl stop` does. Windows has no `SIGTERM`. A process ended from outside, such as by Task Manager or `taskkill /F`, ends at once, as with `SIGKILL` elsewhere. Closing its console window ends the rack without an orderly shutdown, as a hangup does elsewhere.
- **The management endpoint** listens on loopback TCP with a token, since Windows has no Unix sockets. See [Managing a running rack](managing.md).
- **The control file.** Windows has no file modes: the control file is as private as `%LOCALAPPDATA%`, the local application data folder of your user profile.
- **Paths.** The rack reports paths with `\`, such as `source` in `status()`. Manifests may write relative paths with `/` on every system.
