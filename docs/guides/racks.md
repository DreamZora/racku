# Racks

A rack is one process, and its manifest says which devices it holds: placed in slots by hand, or scanned from directories of device files.

## Placing devices by hand

A manifest names the device file in each slot. It never imports device code; the rack loads devices by path.

```ts
// rack.ts
import { rack, slot } from "racku";
import { httpPanel, memkv } from "racku/std";

export default rack("hello", {
  slots: {
    1: memkv(),
    3: slot("./devices/greeter.ts", { config: { prefix: "Hello," } }),
    4: slot("./devices/web.ts"),
    5: httpPanel({ port: 3000, routes: { "/greet": "web.http" } }),
  },
});
```

The `web` device is defined under [HTTP panel](http.md). The panel is a device too, above the devices it routes to.

- Relative device paths resolve against the rack base directory, which for `rack start` and `rack dev` is the manifest's directory.
- A device's name defaults to its model. Give devices that share a model distinct names with `slot(path, { name })`.
- Each need is wired to the only port with the same connector id among the devices below it. When there are several, add a patch: `patch: [["greeter.cache", "memkv.kv"]]`.
- The rack refuses to start when slots overlap, a device does not fit, two devices share a name, a need has no provider below it or more than one, or a patch names something that does not exist.

## Scanned racks

Instead of placing every device by hand, a manifest can name the directories that hold device files, and let the rack work out the instances, their wiring, and their slots:

```ts
// A scanned manifest: slots and patches are worked out from the device files.
import { rack } from "racku";
import { httpPanel, sqlite } from "racku/std";

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
  - So tests go outside such a directory, such as in `test/`: a test file in it fails the start with `RACK_MANIFEST`.
  - A `slot()` or standard-device spec adds one file, and its `config` becomes that model's default. A `name` in it defines a variant: the same file under another model name.
- **`roots`** names the models the rack starts on its own. Everything else starts only when something needs it, such as the models that a panel's routes name.
- **`hotplug`** names directories whose devices start on their own, and come and go with their files while the rack runs, as [Hot-plug devices](hotplug.md) describes.

## Shared instances and own copies

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
- **Changes:** a scanned rack's instances come and go with its plan, so `plug`, `unplug`, and `swap` with another file fail with `RACK_SWAP_REJECTED`. `reload()` and `rack dev` replace the instances whose files changed. When the plan itself changes, for example with a new need, the running rack moves to the new plan as [Changed plans and edited manifests](updates.md#changed-plans-and-edited-manifests) describes.

## The plan file

The rack keeps the plan in `<rack name>.plan` next to the manifest, one line per instance with its slot, model, owner, and wiring. Commit it like a lockfile. It records the layout, not firmware versions, so only layout changes show up in review.

- The first start writes it. After that, `rack start` follows the file as written while it fits the devices. When it no longer fits, `rack start` refuses to start and lists the differences.
- A changed priority alone doesn't change the order `rack start` follows.
- `rack dev` rewrites the file whenever the devices or the priorities give another plan, and leaves it as it is otherwise. It applies a new order to the running rack by moving slot numbers.
- `rack plan` prints the plan without starting the rack. `rack plan --write` writes the file, and `rack plan --check` exits with code 1 while the file is missing or no longer fits, for CI.
- `rack start --no-plan`, `rack dev --no-plan`, and `start(manifest, { plan: false })` run without a plan file; the graph and the priorities alone decide the order.
