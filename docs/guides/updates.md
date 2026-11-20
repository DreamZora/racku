# Updates

Every change of a device's firmware, configuration, or place in a running rack goes through one process, the swap.

## The swap sequence

Every swap follows the same sequence:

1. The new firmware boots in a standby instance, and the rack checks that ports other devices use, a panel's routes included, still exist with the same connector. If not, the swap is rejected with `RACK_SWAP_REJECTED`.
2. The new instance runs `powerOn` and `selfTest` while the old one keeps serving.
3. The old instance runs `deactivate`. If the device has `snapshot`/`restore`, calls to the slot are held while the old instance finishes its calls, and its snapshot is restored into the new instance.
4. The new instance runs `activate`. Calls to the slot are held for a moment and then switch to it in one step; held calls go to the new instance, and none are lost.
5. The old instance finishes the calls it still holds, runs `powerOff`, and is terminated. Calls still running after `drainTimeout` fail with `RACK_LINK_DOWN`.

If anything in steps 1–4 fails, the new instance is discarded, the old one is reactivated and keeps serving, and the slot reports `degraded`. Its watchdogs watch it again from there. An old instance that doesn't answer `deactivate` within `hookTimeout`, or doesn't activate again, can't keep serving: the rack ends it and resets the device from its old firmware, as after a watchdog bite.

## Hot swaps, cold swaps, and restarts

The sequence above is a **hot swap**, and `reload()`, `rack dev`, and `swap()` use it by default. Two more kinds replace a device without letting its old and new instances overlap:

| | Hot swap | Cold swap | Restart |
|---|---|---|---|
| Old and new instance | Overlap; the new one starts first | Never overlap; the old one stops first | Never overlap |
| Calls to the device | Held for a moment | Held while it stops and starts | Held while it stops and starts |
| State | Moves through `snapshot` and `restore` | Moves through `snapshot` and `restore` | Starts fresh |
| Used for | Every compatible change | Devices that declare `swap: "cold"`, and contract changes | `rack.restart(name)` |

- **Cold swaps.** A device declares `swap: "cold"` when two of its instances must never run at the same time, for example because it holds a file lock or a serial port. The new instance starts only once the old instance's thread has stopped, even a thread blocked in native code, as [Stuck threads](faults.md#stuck-threads) describes. Calls that arrive meanwhile wait for the new instance, up to their own timeouts. If the new instance fails to start, the old firmware starts again from its snapshot, and the slot reports `degraded`.
- **Restarts.** `rack.restart(name)` rebuilds the device from its file and starts it from scratch, without its state. Its direct consumers then reload, keeping their state, so their `powerOn` runs again against the new instance. `{ cascade: false }` leaves the consumers running. If the restarted device fails to start, its old firmware starts again without state.
- **Contract changes.** A new firmware can change a port that consumers use, for example by moving a connector to `/v2`. When the consumers' new firmware matches the change, as it does when they share the edited connector file, the rack replaces the provider and those consumers together. The group stops top down and starts bottom up, with each device's state carried over. When a consumer's firmware does not match, nothing stops, and the replacement fails with `RACK_SWAP_REJECTED`.
- **Results.** `reload()` and `restart()` resolve with one result per device, and each result and `swap` event carries a `mode`: `hot`, `cold`, `restart`, `plug`, or `unplug`.

A hot swap hands over everything the rack holds. In-memory state crosses only through `snapshot`, because a Worker's memory cannot move to another Worker.

| Context | How it reaches the new instance |
|---|---|
| Calls in flight | They finish on the old instance before it retires |
| New calls | Held, then sent to the new instance in order |
| Links to and from other devices | Switched to the new instance in one step |
| Event subscriptions | Made again by the new instance, usually in `powerOn` |
| Events sent to it during the hold | Queued, then delivered, up to `queueLimit` |
| HTTP connections and WebSockets | Stay with the [HTTP panel](http.md), a device of its own; a device's own [listener](listeners.md) hands its port over |
| Timers and background tasks | Stopped by `deactivate`, started again by `activate` |
| In-memory state | `snapshot` on the old instance, `restore` on the new one |
| Open files and sockets | Not handed over: the old instance closes them and the new one opens its own |

## Changed plans and edited manifests

When a scanned rack's plan changes, or `rack dev` sees the manifest change, the running rack moves to the new layout without a restart:

1. Devices that are new are plugged, from the bottom up, and devices that stay move to their new slots without restarting.
2. Devices whose firmware or configuration changed are replaced.
3. Needs whose provider changed are rewired. The device keeps running, and only its calls switch to the new provider.
4. Devices that left are unplugged, from the top down, once nothing uses them.

- **Failures:** each step leaves a valid rack. A step that fails is reported in the results of `reload()`, and the rest of the rack keeps running.
- **Under `rack start`:** the plan file decides. A new plan runs only once the file records it, for example after `rack plan --write`.
- **Restart needed:** renaming the rack, and switching between slots and scanned devices.
- **From code:** `reload(manifest)` applies an edited manifest the same way.

## Fallback

An update can pass `selfTest` and still be defective. The rack guards against that in two ways.

- **Known-good firmware.** Each device has one: the firmware it started with at cold start, or the last firmware that got through probation. In an executable, a device's first known-good firmware is the one packaged inside it, so a device that starts from an outside file starts on probation, as [A rack in one executable](running.md#a-rack-in-one-executable) describes.
- **Probation.** After an update, the new instance is on probation for `probation` milliseconds, 60 000 by default.
- **Falling back.** If the instance crashes on probation, or a watchdog bites, the rack does not reset it from the same firmware. It starts the known-good firmware instead, fresh, and the slot reports `degraded` with the crash as its error. A group replaced together for a contract change falls back together, so providers and consumers keep matching contracts.
- **Limits.** A device falls back at most once per update. Setting `probation: 0` turns fallback off.
- **Status.** `status()` shows each device's `knownGood` firmware hash, and `probationUntil` while it is on probation.

## Rollback

- `rack.rollback(name)` goes back to the firmware before the current one, as a hot or cold swap, keeping the state. Undoing a group replacement takes the whole group back.
- `rack.rollback(name, { to: hash })` goes back to any firmware the history still keeps.
- A rollback restores code only. When the earlier firmware has other needs than the running plan, the rollback fails with `RACK_SWAP_REJECTED`, and nothing changes.

## History

- `rack.history(name?)` lists the updates newest first, for the whole rack or for one device. That covers every swap, cold swap, restart, plug, unplug, rollback, and fallback, whether it succeeded or failed.

  ```js
  { seq: 12, time: 1763300000000, device: "orders", mode: "restart", cause: "fallback",
    from: "9c1e…", to: "7f3a…", ok: true, error: { code: "RACK_DEVICE_FAULT", message: "…" } }
  ```

- **Fields.** `mode` says how the device was updated: `hot`, `cold`, `restart`, `plug`, or `unplug`. `cause` says what asked for it: the operation, `reload`, `swap`, `restart`, `rollback`, `plug`, or `unplug`, or a `fallback`. So a device that `reload()` plugs or unplugs has the cause `reload`, and only `plug()` and `unplug()` give the causes `plug` and `unplug`. Records of one group replacement share a `group`. The rollback records are the ones whose cause is `rollback` or `fallback`.
- **Limit.** The history keeps at most `historyLimit` records, 256 by default, in memory, and a restart of the rack starts it empty.
- **Firmware files.** The rack deletes the firmware bundles it built once nothing needs them: no instance, no known-good firmware, and no kept record. So `.rack/firmware/` stays bounded, and `rollback` reaches only the firmware the kept records name.
