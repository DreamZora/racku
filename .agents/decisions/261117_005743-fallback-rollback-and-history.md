# Decision: Fallback, rollback, and update history

Status: accepted

## Background

- An update can succeed and still install a defective device. A swap, cold swap, restart, or group replacement can pass `selfTest`, and the device can then crash a minute later, or on its first real call.
- In P0, a crashed device resets from the same firmware. After more than 3 crashes within 60 seconds, its slot is marked faulted. A defective update therefore takes the device down until someone fixes its file.
- The rack forgets a device's previous firmware once a swap finishes, so the only way back is to edit the files and reload.
- The firmware bundles themselves stay in `.rack/firmware/` and are never deleted. Every edit under `rack dev` adds one, about 320 KB for the counter device of the 2026-11-16 demo, including its inline source map.
- On 2026-11-17 the user asked for:
  - a fail-safe against device defects in updates, as a passive fallback or an active rollback;
  - an interface to read rollback records, keeping a bounded number of them.

## Decision

### Known-good firmware and probation

- Each device has a known-good firmware, which is what the rack falls back to:
  - At cold start, the firmware each device starts with is known-good.
  - Every later update puts the new instance on probation for `probation` milliseconds. This is a new start option, with a default of 60 000.
  - When the instance gets through probation without crashing, its firmware becomes the device's known-good firmware.
- `status()` reports each device's `knownGood` firmware hash, and `probationUntil` while its instance is on probation.

### Passive fallback

- When an instance on probation crashes, the rack does not reset it from the same firmware. It falls back instead:
  - The device starts again from its known-good firmware, fresh, as a reset does. Its slot reports `degraded`, with the crash as the error.
  - When the update was a group replacement for a contract change, the whole group falls back to its known-good firmware, in the order of a group replacement. Consumers and their provider then keep matching contracts.
- A device falls back at most once per update. If the known-good firmware crashes too, the ordinary reset rules apply, up to the crash limit.
- `probation: 0` turns passive fallback off. Crashes then always reset from the current firmware, as in P0.
- Later decisions for the watchdog, the breaker, or thermal may add other reasons to fall back. They would use the same mechanism.

### Active rollback

- `rack.rollback(name, options?)` replaces a device's firmware with an earlier one:
  - By default it goes back to the firmware the device ran before its current one. `{ to: hash }` names any firmware that the history still keeps.
  - It chooses the kind of replacement as `reload()` does. That is a hot swap when contracts match, a cold swap when the device declares `swap: "cold"`, and a group replacement when the earlier firmware changes a contract.
  - When the update being undone replaced a group, the rollback replaces the same group.
- The earlier firmware must fit the running plan, with the same needs and the same wired ports. Otherwise `rollback` fails with `RACK_SWAP_REJECTED` and changes nothing.
- A rollback restores code only. The configuration stays as the manifest gives it now.
- A rollback to the known-good firmware starts no probation. A rollback to any other firmware goes on probation like any update.

### Update history

- The rack records every update in its history, whether it succeeded or failed, including the updates that `reload()` and `rack dev` make. That covers every hot swap, cold swap, restart, group replacement, plug, unplug, rollback, and fallback.
- `rack.history(name?)` returns the records, newest first, for one device or for the whole rack:

  ```ts
  interface UpdateRecord {
    seq: number; // increases by one per record within the rack process
    time: number; // millisecond timestamp of the start of the update
    device: string;
    mode: "hot" | "cold" | "restart" | "plug" | "unplug"; // as in ReloadResult
    cause: "reload" | "swap" | "restart" | "rollback" | "fallback" | "plug" | "unplug";
    from: string | null; // firmware hash before the update
    to: string | null; // firmware hash the update installed, or tried to install
    ok: boolean;
    error?: WireError; // why the update failed, or why the device fell back
    group?: number; // seq of the first record of the same group replacement
  }
  ```

- The rollback records are the records whose `cause` is `rollback` or `fallback`.
- Bounds:
  - The history keeps at most `historyLimit` records, a new start option with a default of 256. The oldest record is dropped first.
  - A rack process keeps a firmware bundle it built while any of these needs it: a running or standby instance, some device's known-good firmware, or a kept record. It deletes the others, so `.rack/firmware/` stays bounded too, also in long `rack dev` sessions.
  - A rack never deletes bundles it did not build, so racks that share a base directory do not delete each other's firmware.
  - `rollback` can therefore reach only firmware that a kept record names.
- The history and the known-good firmware live in memory, and start empty with each rack process. Keeping them across restarts would need a decision of its own.

## Alternatives

- **Active rollback only**: no probation to configure. But a device that crashes at night stays down until someone rolls it back, which is the failure the user wants to guard against.
- **Fall back on any crash, not only during probation**: it would also cover defects that show up late. But a device that crashes for reasons outside its code, such as a full disk, would bounce to old firmware long after its update proved itself.
- **Keep every firmware bundle**: rollback could reach anything. But `.rack/firmware/` would keep growing, by one bundle per edit in `rack dev`.
- **Keep a history per device instead of one for the rack**: a busy device could not push out another device's records. But the bound would then grow with the number of devices, including `own` copies that come and go with the plan.
- **Store the history on disk**: rollback records would survive restarts. But rollback targets would also have to survive, which needs a retention policy across processes. It can come later.

## Impact

- A defective update falls back by itself within the probation window, and an operator can undo any update the history still keeps.
- Changes to P0 behavior:
  - A crash during probation falls back instead of resetting from the same firmware.
  - Firmware bundles that nothing needs are deleted.
- New public API:
  - `rollback` and `history` on the rack handle, and `UpdateRecord`.
  - `knownGood` and `probationUntil` in `SlotStatus`.
  - The start options `probation` and `historyLimit`.
- The update kinds come from [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md), and `rollback` and `history` are among its [on-demand reloads](261116_233956-cold-swaps-and-restarts.md#on-demand-reloads). [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md) makes them reachable from outside the process.
- Follow-up work once this decision is accepted:
  - Probation, fallback, rollback, the history, and firmware retention in `src/rack.ts` and `src/firmware.ts`.
  - Tests:
    - a crash during probation falls back, and a crash after probation resets
    - group fallback
    - rollback, both by default and with `to`
    - a rollback that does not fit the plan is rejected
    - the history bound and its order
    - firmware deletion and retention
  - A README section on update safety.

## Implementation

- **API.** `rollback`, `history`, `UpdateRecord`, `UpdateCause`, and `RollbackOptions`, `knownGood` and `probationUntil` in `SlotStatus`, and the start options `probation` and `historyLimit` are all in `src/rack.ts`.
- **Records.** Every update emits one `swap` event per device, whether it succeeded or failed, so `#record` turns those events into history records.
  - The cause travels in an `AsyncLocalStorage` context that `#operate` sets for each management operation. A fallback that a crash starts in the middle of a reload therefore keeps its own cause.
  - `time` is when the operation that made the record started.
  - A fallback's own event is a success. Its record keeps the crash as `error`, with `ok: true`.
- **Probation.** `#startProbation` runs after each successful update, unless the cause is a fallback.
  - A device whose new firmware is its known-good firmware gets no probation. That covers a rollback to known-good firmware, and a restart's consumers, which reload from the firmware they run.
  - Plugging a device makes its firmware known-good at once, as a cold start does, since there is nothing to fall back to.
- **Fallback.** `onExit` checks for probation before resetting.
  - `#fallBack` resets a single device from its known-good firmware.
  - `#fallBackGroup` runs in the management queue and takes the group back through the cold engine of [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md#cold-swaps).
- **Rollback.** `#rollback` finds the update that installed the current firmware, and its group, in the history.
  - The earlier firmware must have the same need names as the running plan. Their connectors may differ, as when a group undoes a contract change; the replacement checks them.
- **Firmware files.**
  - Every build goes through `#build`, which records the bundles this rack built.
  - `#collectGarbage` runs at the end of each management operation, in the queue, so it never deletes a bundle that an operation has built and not yet booted.
- **Tests:** `test/safety.test.ts`. Ten parts of the implementation were each taken out in turn, and each time at least one test failed.

## Confirmation

- The user asked for a passive fallback or an active rollback against device defects, and for bounded rollback records, and accepted this decision on 2026-11-17.
