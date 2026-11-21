# Decision: Automatic assembly from scanned device files

Status: accepted

## Background

- In a P0 manifest the builder places every device instance by hand:
  - Each instance gets a slot number, which also fixes the start order and the layering.
  - Each copy of a device file gets a name.
  - Each need with several candidate providers gets a patch.
- A consumer that needs a private copy of a provider gets one only when the builder mounts the copy and patches the need to it.
- On 2026-11-16 the user asked to scan device files and let the rack work out the instances, their start order and dependencies, whether each dependency is shared or a private copy, and any circular dependencies. The user's example:
  - Device types A to F are scanned. A, B, and C depend on D, E, and F.
  - A needs its own D and its own F. B needs a shared E. C needs the shared E and its own F.
- On 2026-11-17 the user decided how the order is fixed:
  - A device file may declare an optional start priority. It guides the order only where the dependency graph leaves a choice, and never overrides the graph.
  - A plan file is mandatory and binding, like a lockfile: when it exists, the rack follows it. Without one, the order comes from the dependency graph combined with the priorities.
  - Under `rack dev`, priority changes apply at once.
  - A run mode without any plan file orders the instances from the graph and the priorities alone.
  - [Rack runtime architecture](261112_035942-rack-architecture.md) stays as it is, with a note, and this decision comes first where the two differ.
- [Rack runtime architecture](261112_035942-rack-architecture.md#alternatives) rejected ordering devices automatically from the dependency graph and using slots only for display. It gave three reasons:
  1. The topological order is not necessarily unique.
  2. Slots lose their real meaning.
  3. The rack elevation drawing is no longer the dependency graph.

  [Placement](#placement) answers each one.

## Decision

### Shared and own needs

- A need either shares its provider or owns a copy of it:

  ```ts
  import { device, own } from "rack42u";

  export default device({
    model: "a",
    needs: {
      cache: Kv, // shared: wired to the one shared instance of the provider
      d: own(D), // own: wired to a copy of the provider that serves only this instance
    },
    // ...
  });
  ```

- A plain connector shares, as in P0. `own(connector)`, a new export of `rack42u`, asks for a copy.
- A need still names a connector, never a device file, so devices stay unaware of each other's code.
- `ctx.ports` and `ctx.on`, and their types, are the same for both kinds of need.
- In a manifest that places devices by hand, an `own` need must be wired to an instance that no other need is wired to. Otherwise assembly fails with `RACK_MANIFEST`.

### Scanned manifests

```ts
import { rack } from "rack42u";
import { sqlite } from "rack42u/std";

export default rack("app", {
  devices: ["./devices", sqlite({ path: "data/app.db" })],
  roots: ["a", "b", "c"],
  panel: { http: { port: 3000, routes: { "/api/*": "a.http" } } },
});
```

- `devices` lists where device types come from:
  - **A directory.** Every `.ts`, `.tsx`, `.js`, and `.mjs` file below it, at any depth, is a device file.
    - `node_modules` is skipped, as are files and directories whose names start with `_` or `.`.
    - A file that does not default-export a device fails assembly with `RACK_MANIFEST`.
  - **A `slot()` spec or a standard-device spec.** It adds one device file, and its `config` becomes the default configuration of that model. A `name` in it defines a variant: the same file under that model name, with its own configuration.
- The rack builds each file once and boots it once in a Worker to read its FRU data. The main thread still never imports device code.
- Model names must be unique among the types.
- `roots` lists the models the rack starts on its own. A panel route that names a model makes that model a root as well.
- A type that is neither a root nor needed by any instance in the plan is not started. `rack plan` lists it as unused.
- `use` picks a provider when several types provide a need's connector:
  - A key is either a connector id, which covers every need of that connector, or `<model>.<need>`, which covers that one need and wins over the connector id.
  - A value is a model name.
- `config` gives configuration by instance name or by model. An instance name wins over its model, and both win over the configuration given in `devices`.
- A manifest has either `slots`, with optional `patch`, or `devices`, never both.

### The plan

The rack turns a scanned manifest into a plan of instances:

1. Each root gets the shared instance of its model, named after the model.
2. For every need of every instance in the plan, the rack picks the provider type: the one `use` names, or else the only type that provides the need's connector. When no type provides it, or several do and `use` names none, assembly fails with `RACK_MANIFEST`.
3. A shared need is wired to the shared instance of the provider type. The plan creates that instance once.
4. An `own` need is wired to a new instance of the provider type that serves only this consumer instance. It is named `<consumer>-<need>`, so copies of copies chain names, for example `a-d-log`.
5. Steps 2 to 4 repeat for every new instance.

- Names depend only on model names and need names, never on the order of files or of the scan, so the same files always give the same names. A reload uses these names to match each old instance with its new firmware.
- When a computed name collides with another instance's name, assembly fails with `RACK_MANIFEST`.
- `ctx.slot.name` is the instance name, so a device can derive per-instance resources from it, such as a database path for each copy.

### Cycles

- The rack expands the plan depth-first and keeps the path from the root. A need whose provider type is already on that path is a cycle, whether the need is shared or own.
- Assembly then fails with `RACK_MANIFEST` and prints the path as `<instance>.<need>` steps, for example `cycle: a.d → a-d.back → a`.
- Because the check works on types, expansion always ends. An `own` copy that would need its own type again is a cycle too.

### Start priority

- A device file may declare `priority`, an integer that defaults to 0:

  ```ts
  export default device({ model: "migrate", priority: 10, needs: { db: Sql } /* ... */ });
  ```

- A higher priority starts earlier, but priority never overrides the dependency graph. A device always starts after everything it needs, whatever its priority.
- A device passes its priority down to what it needs. An instance's effective priority is the highest priority among the instance itself and every instance that needs it, directly or indirectly. A high-priority device therefore pulls its dependencies forward instead of waiting behind unrelated devices.
- In a manifest that places devices by hand, slot numbers fix the order and priorities are ignored.

### Placement

- When there is no [plan file](#plan-file), the rack orders the instances itself:
  1. An instance can be placed once everything it needs is placed.
  2. Among the instances that can be placed next, the rack takes the one with the highest effective priority. Ties go to the lowest layer, then to the first name.
     - An instance's layer is 0 when it needs nothing, and otherwise one more than the highest layer among the instances it needs.
     - When priorities are equal, layers keep storage low and entry points high.
  3. Instances take slots from 1 upward in that order, each with its height. When they do not fit the rack size, assembly fails with `RACK_MANIFEST`.
- Start order is slot order, and shutdown runs in reverse.
- This answers the three objections of the architecture decision:
  1. **The order is unique.** The same files, priorities, and manifest always give the same order, and the plan file then fixes it.
  2. **Slots keep their meaning.** Every instance sits above everything it needs, so the gravity rule holds. Cold start still runs bottom up and shutdown top down, and `status()` reports real slots.
  3. **The elevation is still the dependency graph.** The rack draws it instead of the builder, `rack plan` prints it, and the [plan file](#plan-file) keeps it under review.

### Plan file

- Every scanned rack has a plan file, `<rack name>.plan` in the base directory, for example `app.plan` for `rack("app", ...)`. It is committed like a lockfile, and it is binding: the rack runs the plan the file records.
- The rack writes the file, and it is not meant to be edited by hand. It is line-oriented text, one line per instance in slot order, giving its slot, name, model, owner, and wiring.
  - It records structure only, not firmware hashes, so ordinary code edits leave it unchanged.
  - Adding, removing, moving, or rewiring an instance changes the file, so the change shows up in review.
- Which plan runs:
  - **The file fits the dependency graph.** It fits when it has the same instances with the same wiring, and every instance sits above everything it needs.
    - `rack start` and `start()` follow the file as written. A changed priority alone does not change their order until the file is rewritten.
    - `rack dev` rewrites the file whenever the graph and the priorities give a different order, including an order that only priorities changed, and applies it.
  - **There is no file.** The rack orders the instances from the graph and the priorities, as [Placement](#placement) describes, runs that plan, and writes the file.
  - **The file no longer fits the graph.**
    - `rack dev` and `rack plan --write` order the instances again and rewrite the file, logging what changed.
    - `rack start` and `start()` fail with `RACK_MANIFEST` and list the differences, so a layout that nobody reviewed never starts.
- `rack plan --check` fails when the file is missing or no longer fits the graph, for CI.
- **Running without a plan file.**
  - `rack start --no-plan`, `rack dev --no-plan`, and `start(manifest, { plan: false })` run a scanned rack without a plan file. The rack neither reads nor writes one.
  - It orders the instances from the graph and the priorities each time it starts, and applies a changed plan at once, as under `rack dev`.
- A running rack follows the same rules. Under `rack dev`, `reload()` applies a plan that no longer fits the file and rewrites the file. Otherwise `reload()` keeps the running plan and fails with `RACK_SWAP_REJECTED`, listing the differences.

### The user's example

The scan finds types A to F, and `roots` is `["a", "b", "c"]`. A needs `own(D)` and `own(F)`, B needs `E`, and C needs `E` and `own(F)`. The plan:

| Slot | Instance | Model | Serves | Layer |
|---|---|---|---|---|
| U1 | `a-d` | d | `a` only | 0 |
| U2 | `a-f` | f | `a` only | 0 |
| U3 | `c-f` | f | `c` only | 0 |
| U4 | `e` | e | `b` and `c` | 0 |
| U5 | `a` | a | root | 1 |
| U6 | `b` | b | root | 1 |
| U7 | `c` | c | root | 1 |

With `priority: 10` on C, C passes the priority down to `c-f` and `e`, so that branch starts first: `c-f`, `e`, `c`, `a-d`, `a-f`, `a`, `b`, in slots U1 to U7. Every instance still sits above what it needs.

If D needed A through a need named `back`, assembly would fail with `cycle: a.d → a-d.back → a`.

### Commands and management

- `rack plan [manifest]` prints the plan without starting anything: each instance with its slot, model, owner, and wiring.
  - It fails in the same ways startup does.
  - It works for both kinds of manifest. `--write` and `--check` apply only to scanned manifests, as [Plan file](#plan-file) describes.
- `status()` gains `owner`: for a copy made by an `own` need, the instance that owns it.
- In a scanned rack, instances come and go with the plan. `plug`, `unplug`, and `swap` with a new source fail with `RACK_SWAP_REJECTED`.
- Changes to files or to the manifest go through `reload()`, as [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan) describes.

### What stays the same

- Each instance is still one Worker, and links, swaps, resets, metrics, and transfer work as before. The plan only decides which instances exist, where they sit, and how they are wired.
- Manifests with `slots` keep working unchanged.

## Alternatives

- **Keep placing every instance by hand**: there is nothing new to learn and nothing implicit. But every copy, name, and ambiguous need, and the order, stay the builder's work. This mode remains available.
- **Let the provider choose sharing, like the scopes of a dependency-injection container**: a provider knows whether it can safely serve several consumers. But the same provider can be shared by some consumers and owned by another. The consumer is also the one whose correctness depends on having its own copy. Provider defaults can be added later on top of this.
- **Put the sharing choice in the manifest**: device code would stay free of deployment choices. But the manifest would repeat every need, and the choice would sit away from the code that relies on it.
- **Start every scanned type that nothing needs**: there would be no `roots` to write. But a forgotten or half-written file in the directory would start, and the manifest would no longer say what the rack is for.
- **No plan file**: there would be one file fewer to commit. But a one-line change in a device file could add or move instances without anything in review showing it.
- **A plan file that is only a check**: the rack would always compute the order and refuse to start when the result differs from the file. The file would then be a copy rather than the source of the order. The user chose a binding file.
- **Order only by the graph and names**: the order would still be unique, but a builder could not ask for one device to start before an unrelated one.
- **Explicit `after` relations in the manifest instead of priorities**: an `after` relation guarantees an order and is checked for cycles. But the manifest would have to name other devices, while a priority stays in the device file and names nobody. `after` can still be added later for orders that must always hold.
- **Allow pinned slots in a scanned manifest**: the builder could fix some positions. But the computed order would then have to respect them, which adds failure modes. It can come later.
- **Order by the dependency graph and use slots only for display**: the architecture decision rejected this. This decision computes real slots instead.

## Impact

- A builder can describe a rack as directories of device files plus its roots. Before anything starts, the rack works out the copies, names, wiring, order, and slots, and reports cycles, ambiguous needs, and missing providers.
- New public API:
  - `own()` in `rack42u`. A need is either a connector or `own(connector)`.
  - `priority` in `DeviceSpec`.
  - The manifest fields `devices`, `roots`, `use`, and `config`.
  - `owner` in `SlotStatus`.
  - The `rack plan` command, with `--write` and `--check`.
  - The plan file, `<rack name>.plan`, the `--no-plan` flag of `rack start` and `rack dev`, and the `plan` option of `start()`.
- [Device and rack API](261112_043034-device-api.md#rack-manifest) binds the public API. This decision adds to it without changing existing behavior.
- Startup boots each scanned file once to read its FRU data. That costs about one Worker start per file, about 4 ms each according to the [hot swap evidence](261112_035943-hot-swap.md#evidence), and the starts run in parallel.
- Copies share whatever their configuration points at. A device that owns files or other outside resources should derive their names from `ctx.slot.name`, or receive per-instance configuration.
- A code change can change the plan, for example by adding a need or by switching a need between shared and own. [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md) covers applying such changes to a running rack.
- [Rack runtime architecture](261112_035942-rack-architecture.md) rejected automatic ordering. This decision adopts computed placement and keeps real slots and the gravity rule.
  - Where the two differ, this decision comes first.
  - The architecture decision stays as it is, with this note, as the user chose on 2026-11-17, and as the user chose for [direct links](261116_024226-backplane-links.md#confirmation).
  - `AGENTS.md` lists this decision before the architecture decision.
- Follow-up work once this decision is accepted:
  - A planner module, `src/plan.ts`, for expansion, cycles, and placement, used by `start` in `src/rack.ts`.
  - `own()` and the need types in `src/device.ts` and `src/connector.ts`, the manifest fields in `src/manifest.ts`, and `rack plan` in `src/cli.ts`.
  - Tests:
    - the user's example
    - cycles through shared and own needs
    - ambiguity resolved by `use`
    - stable names when files are added
    - deterministic plans
    - priority that pulls a branch forward but never overrides the graph
    - capacity
    - `own` needs in hand-placed manifests
    - the plan file: followed when it fits, written when missing, rewritten by `rack dev` and `rack plan --write`, refused by `rack start` and `start()` when it no longer fits, and checked by `rack plan --check`
    - priority changes applied at once under `rack dev`
    - runs without a plan file
  - A README section on scanned manifests, and the new module in the `AGENTS.md` layout.

## Implementation

- **Device API.**
  - `own`, `isOwn`, `needConnector`, and `priority` are in `src/device.ts`.
  - FRU data carries them as `NeedInfo.own` and `Fru.priority`, in `src/protocol.ts`.
- **Reading FRU data for planning.**
  - The `describe` control request is answered by `describe` in `src/worker.ts`, and sent by `Instance.describe` in `src/instance.ts`.
  - `#describe` in `src/rack.ts` uses it and caches the result by firmware hash, so a reload describes only changed firmware.
- **The planner and the plan file:** `makePlan`, `formatPlan`, `parsePlan`, and `fitPlan` in `src/plan.ts`. The planner is pure, so its tests need no Workers.
- **Scanned manifests:** the `devices`, `roots`, `use`, and `config` fields of `rack()` in `src/manifest.ts`.
- **The rack** (`src/rack.ts`):
  - `#prepare` boots and wires the devices, and `#planScanned`, `#scanModels`, `#computePlan`, and `#choosePlan` work out the plan.
  - A plan compiles to slots and patches, so the existing assembly checks its wiring, the gravity rule, and connector coverage.
  - `#ownershipProblem` checks `own` needs in hand-placed manifests, at start, plug, and swap.
  - `#owners` supplies `owner` in `status()`.
- **Commands:** `rack plan` with `--write` and `--check`, and `--no-plan`, in `src/cli.ts`. `rack plan` goes through `planRack` in `src/rack.ts`, which boots and wires every device as `start()` does and then terminates them.
- **The `plan` start option.**
  - `start()` takes `plan: true | "update" | false`.
  - `"update"` is how `rack dev` rewrites the plan file, and `README.md` documents it as well.
- **Changed plans while running.** `reload()` of a scanned rack moves to a changed plan as [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan) describes. Under `rack start`, it does so only once the plan file records the new plan.
  - Under `rack dev`, `#writePlanFile` writes the plan file only when its text changes, since the watcher counts every write as a change. Until 2026-11-21, every reload wrote it, so the first change of a file in a scanned rack under `rack dev` set off reloads without end. A test in `test/assembly.test.ts` checks that a reload with the same plan leaves the file as it is.
- **Tests:**
  - `test/plan.test.ts` covers the planner and the plan file.
  - `test/assembly.test.ts` covers scanned racks through Workers and through the `rack` command.
  - `test/device.test.ts` and `test/manifest.test.ts` cover the API additions.
  - Ten parts of the implementation were each taken out in turn, and each time at least one test failed.

## Confirmation

- The user accepted this decision on 2026-11-17, after shaping it in review:
  - The user proposed the start priority in the device file, as a soft input under the dependency graph. The Agent had suggested `after` relations in the manifest, which [Alternatives](#alternatives) records.
  - The plan file is mandatory and binding, as the user asked: without one, the order comes from the graph and the priorities, a run mode works without any plan file, and `rack dev` applies priority changes at once.
  - The user chose to keep [Rack runtime architecture](261112_035942-rack-architecture.md) with a note, with this decision coming first, and accepted the names `devices`, `roots`, `use`, and `own()`.
