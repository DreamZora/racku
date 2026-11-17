# Decision: Hot swaps, cold swaps, and restarts

Status: accepted

## Background

- P0 changes a running device in one way: the hot swap of [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence). The new instance starts before the old one stops, calls are held for a moment, and state moves through `snapshot` and `restore`.
- A hot swap refuses changes that would break consumers. When a wired port disappears, changes its connector, or loses a member that a consumer needs, the swap fails with `RACK_SWAP_REJECTED`, and the whole rack has to be restarted.
- Swapping several devices together and editing the manifest of a running rack are not in P0 either.
- On 2026-11-16 the user asked for two kinds of reload:
  - Hot reload, with a complete handoff of the device's context.
  - Stop-and-reload: device A shuts down completely and starts again from scratch, and the devices that depend on A reload automatically to adapt to the new A.
- On 2026-11-17 the user agreed that a restart reloads only the device's direct consumers, and asked for an interface to hot reload or restart devices on demand.
- Under [Automatic assembly from scanned device files](261116_233919-automatic-assembly.md), a code change can also change the plan of a running rack. For example, a device can gain a need, or a need can switch between shared and own.

## Decision

### Three ways to replace an instance

| | Hot swap | Cold swap | Restart |
|---|---|---|---|
| Old and new instances | Overlap: the new one starts first | Never overlap: the old one stops first | Never overlap |
| Calls to the device | Held for a moment | Held while it stops and starts | Held while it stops and starts |
| State | Moves through `snapshot` and `restore` | Moves through `snapshot` and `restore` | Starts fresh |
| Used for | Every compatible change, as in P0 | Devices that declare `swap: "cold"`, and contract changes | `rack.restart(name)` |

- All three are variants of the one swap process. They share its checks, holds, drains, events, and rollback.
- The user's hot reload is the hot swap. The user's stop-and-reload is the restart.

### What a hot swap hands over

| Context | How it reaches the new instance |
|---|---|
| Calls in flight | They finish on the old instance before it retires |
| New calls | Held, then sent to the new instance in order |
| Links from consumers | Switched to the new instance in one step |
| Links to providers | The new instance gets its own links before `powerOn` |
| Event subscriptions | Made again by the new instance, usually in `powerOn` |
| Events sent to it during the hold | Queued, then delivered |
| HTTP connections | Stay with the panel |
| Timers and background tasks | Stopped by `deactivate`, started again by `activate` |
| In-memory state | `snapshot` on the old instance, `restore` on the new one |
| Open files, sockets, and native handles | Not handed over: the old instance closes them and the new one opens its own |

- This is the most complete handoff the rack can make. A Worker's memory cannot move to another Worker, because functions, closures, and open handles cannot be cloned. State the device wants to keep must go through `snapshot`.
- The hot swap itself does not change.

### Cold swaps

- A device declares `swap: "cold"` when two of its instances must never run at the same time, for example because it holds a file lock or a serial port:

  ```ts
  export default device({ model: "printer", swap: "cold" /* ... */ });
  ```

- A cold swap runs in this order:
  1. Build the new firmware, boot the new instance in standby, and check its FRU data as a hot swap does. A failure here changes nothing.
  2. Hold calls to the device.
  3. The old instance runs `deactivate`, finishes its calls within `drainTimeout`, runs `snapshot` if it has one, runs `powerOff`, and is terminated.
  4. The new instance runs `powerOn`, `selfTest`, `restore` with the snapshot, and `activate`, and is installed.
  5. The held calls go to the new instance.
- If step 4 fails, the rack starts the old firmware again from the same snapshot. If that fails too, the slot is marked faulted. Either way the slot reports the error, as it does after a failed hot swap.
- Held calls keep their deadlines, so a call held past its timeout fails with `RACK_TIMEOUT`. The hold queues keep their limit of 10000 calls.

### Restarts

- `rack.restart(name, options?)` stops a device completely and starts it again from scratch, without its state:
  1. It rebuilds the device's firmware from its file, as `swap(name)` does. A build failure changes nothing.
  2. It runs steps 1 to 3 of a cold swap, without `snapshot`.
  3. The new instance runs `powerOn`, `selfTest`, and `activate`, without `restore`, and the held calls go to it.
  4. The device's direct consumers then reload to adapt to the new instance. Each one is hot-swapped from its current firmware, or cold-swapped if it declares `swap: "cold"`. They keep their state and run `powerOn` again against the new instance.
- `{ cascade: false }` skips step 4. The consumers keep running; their calls just wait while the device restarts.
- Consumers of consumers do not reload. The contracts they use did not change, and their links already point at the new instances.
- When the new firmware changes the device's contract, the restart replaces the device and its consumers as a group, as [Contract changes](#contract-changes) describes, with the device starting fresh.
- If the restarted device fails to start, its slot resets from the same firmware, as after a crash, and its consumers do not reload.
- `restart` resolves with one `ReloadResult` per device it replaced, in the order it replaced them.

### Contract changes

- Some changes would make a hot swap refuse: a wired port disappears, changes its connector, or loses a member a consumer needs. These no longer need a rack restart when the consumers' new firmware matches the new contract, for example because they bundle the same changed connector file.
- `reload()` then replaces the provider and those consumers as a group:
  1. Build everything and boot the new instances in standby. If any new consumer does not fit the new provider, nothing stops, and every device in the group fails with `RACK_SWAP_REJECTED`.
  2. Hold calls to every device in the group.
  3. Stop the group top down, consumers before the provider. Each device runs `deactivate`, finishes its calls, and runs `snapshot` if it has one.
  4. Start the group bottom up, the provider before its consumers, each with `restore`.
  5. Release the held calls.
- If a start fails, the whole group starts again from its old firmware and snapshots, and reports the error.

### Choosing the kind in reload()

- `reload()` handles each device whose firmware changed, bottom up:
  - **A contract change that the consumers' new firmware matches:** the group replacement above.
  - **A device that declares `swap: "cold"`:** a cold swap.
  - **Anything else:** a hot swap, as in P0.
- `rack dev` calls `reload()`, so it follows the same rules.
- `ReloadResult` and the `swap` event gain a `mode` field: `"hot"`, `"cold"`, `"restart"`, `"plug"`, or `"unplug"`.

### On-demand reloads

- The rack handle starts each kind on demand, for one device at a time:
  - `swap(name, source?)` reloads a device now, from its file or from another one. It uses a hot swap, a cold swap when the device declares `swap: "cold"`, or a group replacement when the new firmware changes a contract that the consumers' new firmware matches.
  - `restart(name, { cascade? })` stops the device and starts it again from scratch, as [Restarts](#restarts) describes.
  - `reload()` rebuilds every device and replaces the ones that changed.
  - `rollback(name, { to? })` and `history(name?)` come from [Fallback, rollback, and update history](261117_005743-fallback-rollback-and-history.md).
- Like the P0 management operations, they run one at a time, in call order, and each one is recorded in the update history.
- Operators reach them from outside the rack's process through the [management endpoint](261117_005821-management-endpoint.md).

### Applying a changed plan

- After rebuilding, `reload()` works the plan out again, from the scanned files or from the manifest file when it changed, and compares it with the running plan:
  1. Plug the instances that only the new plan has, bottom up.
  2. Replace the instances whose firmware changed, as above.
  3. Rewire the needs whose provider changed. The backplane gives each such need a link to its new provider and holds the need's calls for the switch; the consumer keeps running.
  4. Unplug the instances that only the old plan has, top down, once nothing is wired to them.
- In a scanned rack, the [plan file](261116_233919-automatic-assembly.md#plan-file) decides whether a changed plan may run at all.
- Each step leaves a valid rack. If a step fails, the rack keeps running with the steps that succeeded, and `reload()` reports the failure.
- An instance whose slot number changes in the new plan keeps running; only its slot number changes. `ctx.slot.u` keeps the value from when the instance started.
- `rack dev` applies manifest edits this way instead of asking for a restart. This delivers the reconcile that [Live manifest edits and rack upgrades](261112_035943-hot-swap.md#live-manifest-edits-and-rack-upgrades) anticipates.

## Alternatives

- **Keep only hot swaps, as in P0**: a contract change needs a rack restart, which stops every device instead of the few that changed.
- **Restart the affected devices fresh, consumers included**: simpler, but consumers would lose state that has nothing to do with the provider.
- **Reload every device above a restarted one, all the way up**: devices further up see no change in the contracts they use, and their links already point at the new instances. Restarting them would only add downtime.
- **Fail calls with `RACK_LINK_DOWN` during cold swaps and restarts**: simpler, but callers would see errors for a planned change. Holding calls is what hot swaps already do.
- **Hand over the whole Worker context automatically**: not possible, because functions, closures, and open handles cannot cross threads.
- **Choose hot or cold per `reload()` call instead of per device**: the builder would have to remember which devices cannot overlap. Declaring it on the device keeps that knowledge with the code that needs it.

## Impact

- Contract changes, groups of devices, and manifest edits no longer need a rack restart. This lifts limits that [P0 scope](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope) lists as not in P0.
- Cold swaps, restarts, and contract changes make the affected devices unavailable while they stop and start. Their calls wait in hold queues meanwhile, and calls held past their deadlines fail with `RACK_TIMEOUT`.
- New public API:
  - `swap` in `DeviceSpec`.
  - `restart` on the rack handle.
  - `mode` in `ReloadResult` and in the `swap` event.
- [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) says that requests are make-before-break, and that a swap must not change a port other devices use.
  - Hot swaps still work that way.
  - Cold swaps, restarts, and contract changes hold requests instead. They do so because the device declares it, because the builder asks for it, or because no compatible overlap exists.
  - That decision stays as it is, with this note.
- Follow-up work once this decision is accepted:
  - Holds over a group of slots, and ordered stops and starts, in `src/rack.ts` and `src/backplane.ts`.
  - Rewiring a need in the backplane, and re-reading the manifest in `src/dev.ts`.
  - Tests:
    - each kind of replacement
    - rollback after a failed start
    - contract changes, both with consumers that match and with consumers that do not
    - plan changes
    - manifest edits under `rack dev`
  - A README section on the kinds of reload and how the rack chooses among them.
- [Fallback, rollback, and update history](261117_005743-fallback-rollback-and-history.md) guards every kind of replacement against defective firmware.

## Confirmation

- The user accepted this decision on 2026-11-17, with a restart that reloads only the device's direct consumers, and with the names `swap: "cold"` and `restart`.
