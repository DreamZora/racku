# Reports

## metrics()

`metrics()` resolves with `{ devices, outside }`. `devices` has one entry per device whose installed instance answered, bottom slot first. Each entry has the device name, the `firmware` hash of the instance that counted, `since` (when that instance booted), its event-loop delay `loop`, and counters per member:

```js
{
  device: "orders",
  firmware: "7f3a9c…",
  since: 1763260000000,
  loop: { delayMs: 0.4, maxDelayMs: 12.5 }, // see "Hangs and watchdogs"
  provides: { // per provided port and member
    http: { handle: { kind: "rpc", calls: 812, ok: 809, errors: { RACK_TIMEOUT: 3 }, active: 1, timeMs: 931.2 } },
  },
  needs: { // per need and member
    cache: {
      get: { kind: "rpc", calls: 790, ok: 790, errors: {}, pending: 0, queued: 0, timeMs: 18.4 },
      changed: { kind: "event", received: 12 },
    },
  },
}
```

- For the RPC members a device provides, `calls` counts the calls it served, including calls from `rack.call` and the HTTP panel; `active` counts the ones it is still serving. For the RPC members of its needs, `calls` counts the calls it made; `pending` counts the unfinished ones, and `queued` the ones waiting while the provider is swapped.
- `ok` counts successes and `errors` counts failures by error code, `RACK_TIMEOUT` and `RACK_CANCELLED` included. `timeMs` is the total duration of the finished calls, so `timeMs / (ok + errors)` is the mean.
- An event member a device provides counts `emitted` events and `dropped` deliveries; one it needs counts `received` events.
- A device's counters live in its Worker, which keeps them from the moment its instance boots, so they restart when a device swaps or resets. A device that does not answer within `hookTimeout` is left out.
- `outside` counts the calls from outside the rack, through `call()`, the way a need counts its calls, by address and member:

  ```js
  {
    ports: { // per <device>.<port> and member
      "greeter.greeter": { greet: { kind: "rpc", calls: 812, ok: 805, errors: { RACK_OVERLOADED: 7 }, pending: 0, queued: 0, timeMs: 1250.7 } },
    },
    unrouted: 0, // calls to an address or member that doesn't exist
  }
  ```

  - It includes the calls that the rack answered itself without reaching a device: refused at `queueLimit`, held past their deadline while the device swapped or reset, or sent to a device that was `faulted` or `resetting`.
  - The HTTP panel's calls are calls between devices, so they count under the panel's needs instead, as [HTTP panel](../guides/http.md) describes.
  - The main thread keeps these counters, so they last across swaps and resets. A port's counters start at its first call, and go away when its device is unplugged; a member's go away when a swap removes the member.
- After `stop()`, `metrics()` resolves with no devices and empty `outside` counters.
