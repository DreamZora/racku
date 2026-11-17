# Decision: Transfer and shared buffers for binary data

Status: accepted

## Background

- Under [Backplane protocol with direct links between devices](261116_024226-backplane-links.md), a call between devices clones its input once and its result once. For binary data the clone copies every byte. A round trip with a 1 MB `Uint8Array` takes 276 µs between two threads, and with 64 MB it takes 77 ms (see [Evidence](#evidence)).
- The platform offers two ways to avoid the copy:
  - **Transfer** moves an `ArrayBuffer` to the receiving thread. The sender's buffer becomes detached, with length 0, so the two sides never share memory.
  - **`SharedArrayBuffer`** memory is never copied. Structured clone gives the receiver another handle on the same memory.
- A `SharedArrayBuffer` already crosses links without a copy, but nothing documents or tests that. It also gives up isolation for the shared bytes, because the rack cannot see or order access to them.
- Transfer is not possible today: links, the data channel, and the hold queues send messages without a transfer list.
- On 2026-11-16 the user asked to add transfer support, as the Agent had suggested, and to document `SharedArrayBuffer`.

## Decision

### Transfer

- `CallOptions` gains `transfer?: readonly ArrayBuffer[]`. It applies to `ctx.ports.<need>.<method>(input, options)` and to `rack.call(address, method, input, options)`.
- A call takes the buffers listed in `transfer`:
  - They are detached as soon as the call is made, whatever its outcome.
  - The provider receives their contents without a copy.
  - A typed array or `DataView` in the input that sits on a listed buffer arrives as a view on the moved buffer. Every view on that buffer in the caller becomes empty.
  - A listed buffer that the input does not reference is still detached.
- The call fails with `RACK_INVALID_INPUT`, and no buffer is detached, when an entry of `transfer` is not an `ArrayBuffer`, is a `SharedArrayBuffer`, is already detached, or appears twice.
- `CallContext`, the second argument of an RPC implementation, gains `transfer(...buffers: ArrayBuffer[]): void`:
  - The buffers it lists move with the result instead of being copied.
  - They are detached when the provider sends the result, whether the call succeeded or failed.
  - Listing a buffer again has no further effect.
  - It throws `RACK_INVALID_OUTPUT` for an entry that is not an attached `ArrayBuffer` or is a `SharedArrayBuffer`, and when called after the result has been sent.
- A call can wait in a hold queue, at the consumer or at the backplane. Such a call moves its listed buffers into the queued copy of its input, so they are detached at once. It moves them again when it goes out.
- Events do not transfer. An event goes to every subscriber, and a buffer can move to only one thread.

### Shared buffers

- A `SharedArrayBuffer` is shared, not copied, wherever it appears: in a call's input or result, or in an event payload. The same holds for a typed array or `DataView` on one. Every device that receives the buffer works on the same memory. Calls from outside the rack share it with the main thread in the same way.
- The rack does not see or order access to shared memory. `README.md` states these rules as part of the device contract; the rack does not enforce them:
  - A shared buffer belongs to the call that carries it. The caller leaves it alone until the call succeeds. The provider does not keep it and does not use it after returning.
  - After a call fails, times out, or is cancelled, the caller does not reuse the buffer. The provider may still be running and writing to it.
  - A shared buffer in an event is read-only for the publisher and for every subscriber.
  - A device does not keep a shared buffer to exchange data with another device outside calls and events, for example as a ring buffer or with `Atomics.wait` and `Atomics.notify`. This covers buffers it received from another device and buffers it passed to one. Such use:
    - escapes the backplane, which cannot hold, drain, or switch that traffic during a swap;
    - is not carried over by a swap, which does not pass the buffer to the new instance;
    - can stall the device, because `Atomics.wait` blocks the device's whole Worker;
    - breaks the rule of [Rack runtime architecture](261112_035942-rack-architecture.md#basic-units) that the backplane is the only channel between devices.
  - A schema can check that a buffer is present, not what it holds. A device validates the bytes it reads.
- A call that waits in a hold queue keeps sharing its buffer. The provider sees the bytes as they are when it reads them, not as they were when the call was made.

### Choosing

| | Copy, the default | Transfer | Shared |
|---|---|---|---|
| The bytes are copied | Yes | No | No |
| Isolation of the bytes | Full | Full | None |
| The sender keeps its buffer | Yes | No | Yes |
| Works for events | Yes | No | Yes |

## Evidence

Measured on 2026-11-16 on Bun 1.4.4, Linux, 32 cores, with probe scripts outside the repository.

- Round trip of one buffer between the main thread and a Worker over a `MessageChannel`, reusing the buffer:
  - Each value is the median of 400 round trips, or 30 for the 64 MB copy.
  - The Worker writes one byte and sends the buffer back the same way.

  | Size | Copy | Transfer | Shared |
  |---|---:|---:|---:|
  | 16 KB | 39.7 µs | 16.9 µs | 9.6 µs |
  | 1 MB | 275.8 µs | 115.9 µs | 105.4 µs |
  | 64 MB | 77,474 µs | 244.7 µs | 219.9 µs |

- Transfer and sharing copy nothing, yet Bun spends about 30 µs each time a buffer of 1 MB or more crosses:
  - On one thread, `structuredClone` of a `SharedArrayBuffer` takes 0.6 µs at 16 KB, 32.6 µs at 1 MB, and 37.6 µs at 64 MB.
  - Moving a 1 MB `ArrayBuffer` into a clone takes about 38 µs more than allocating it.
  - The cause was not found. It is not garbage collection, which ran about once in 200 round trips.
- Through rack42u at commit `222ba8c`:
  - A device passed the same 1 MB `SharedArrayBuffer` to a provider 300 times, and each call took 124.5 µs. With a 1 MB `Uint8Array` that the provider returned, each call took 419.2 µs.
  - The provider's write was visible to the caller.
- Behavior of Bun 1.4.4 that the rules rely on:
  - `postMessage` throws `DataCloneError` for a transfer list that holds a `SharedArrayBuffer`, a detached buffer, a duplicate, a typed array, or a plain object.
  - When `postMessage` throws, it detaches nothing. This also holds when the list is valid and only the message cannot be cloned.
  - `structuredClone({ input, list }, { transfer: list })` detaches the listed buffers, and the copied input refers to the buffers in the copied list.
  - `structuredClone` of a `SharedArrayBuffer` on one thread returns a handle on the same memory.
  - `Buffer.from`, `Buffer.alloc`, `Buffer.allocUnsafe`, and `TextEncoder.encode` each return a view on a buffer of its own, of exactly its length, so transferring that buffer moves nothing else.

## Alternatives

- **Document `SharedArrayBuffer` only**: no API changes. But every binary call would give up isolation for its bytes and rely on rules the rack cannot check.
- **Transfer every `ArrayBuffer` found in a payload**: no API either. But every call would walk its payload. Device code would also find buffers it meant to keep detached after a call, including the whole buffer under a view on part of it.
- **Declare transfer per connector member**: both sides would see it in the contract. But the framework would still walk each payload to find the buffers, and changing a member would change the connector.
- **A `transfer(value, buffers)` wrapper for results**, like the one in Comlink: the list stays next to the value. But it adds an export and widens the return type of every implementation, while `call` already carries per-call details such as `signal` and `deadline`.
- **Detach the buffers only when the call goes out**: a caller could retry after failures that happen before sending. But an error such as `RACK_LINK_DOWN` would not tell the caller whether its buffers were gone.
- **Transfer events**: a buffer can move to only one thread, and an event goes to every subscriber.

## Impact

- Binary data crosses between devices without a copy. Transfer keeps full isolation; a shared buffer gives it up for its bytes.
- `CallOptions` and `CallContext` gain one member each, and existing code is unaffected. [Device and rack API](261112_043034-device-api.md#devices) lists `timeout` and `signal` as call options, and `signal` and `deadline` on `call`; this decision adds `transfer` to both.
- A caller that transfers a buffer loses it even when the call fails, so it cannot retry with it.
- Two earlier decisions require data on ports to be copyable by structured clone: [Rack runtime architecture](261112_035942-rack-architecture.md#impact) and [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#impact). That still holds. Transferred and shared buffers pass structured clone, which moves or shares them instead of copying them. Those decisions stay as they are, with this note.
- Follow-up work once this decision is accepted:
  - Implement transfer in `src/worker.ts`, `src/backplane.ts`, `src/instance.ts`, and `src/rack.ts`, with the shared checks in a new module, `src/transfer.ts`.
  - Document transfer and shared buffers in `README.md`, with a test through links for each claim. The tests cover calls that wait in hold queues and calls from outside the rack.
  - Measure transfer through rack42u and record the result in `## Implementation`.
- Later uses that this decision does not cover:
  - The HTTP panel could transfer request and response bodies.
  - `snapshot` and `restore` could transfer large state, such as a SQLite image.

## Implementation

- Helpers: `src/transfer.ts`.
  - `transferList` checks the `transfer` option of a call and copies it.
  - `untransferable` checks one buffer for `call.transfer`.
  - `detach` detaches what a call or a result still holds.
  - `moveInto` moves the buffers of a queued call into its copy of the input.
- Calls between devices: `callOut`, `enqueue`, `send`, and `settle` in `src/worker.ts`. A call keeps its buffers in `Outgoing.transfer`. `send` posts them with the call, and `settle` detaches any that are still attached.
- Results: `serve` in `src/worker.ts` builds the `call` argument, whose `transfer` collects buffers until the result is sent. A result that succeeded carries them, and a failed one detaches them.
- Calls from outside the rack:
  - `call`, `#dispatch`, and `#finish` of `Backplane` in `src/backplane.ts` take, move, and detach the buffers.
  - `Instance.post` in `src/instance.ts` takes a transfer list.
  - `refuse` in `src/rack.ts` takes the buffers of a call made while the rack is not running.
- Unlike `## Impact` says, not all existing code is unaffected. Code that builds a `CallContext` by hand must now provide `transfer`, for example a test that calls an implementation directly. Two such tests in `test/panel.test.ts`, which call an `http/v1` implementation directly, gained `transfer() {}`.
- Tests:
  - `test/transfer.test.ts`, with the fixture devices `test/fixtures/devices/bytes.ts` and `bytes-client.ts` and the connectors `Bytes` and `BytesClient`.
  - Ten parts of the implementation were each taken out in turn, and each time at least one test failed.
  - `README.md` documents transfer and shared buffers under "Binary data".
- Benchmark through rack42u, measured on 2026-11-16 on the same machine:
  - A device made 400 sequential calls to a provider in a lower slot, reusing its buffer; 30 calls for the 64 MB copy.
  - Copy: the provider returned the `Uint8Array` it received, so the bytes were copied both ways.
  - Transfer: both sides moved the buffer.
  - Shared: the provider wrote one byte into a `SharedArrayBuffer` and returned nothing.

  Each value is the median per call in µs, with the mean in parentheses:

  | Size | Copy | Transfer | Shared |
  |---|---:|---:|---:|
  | 16 KB | 35.1 (37.6) | 14.0 (20.4) | 11.5 (15.5) |
  | 1 MB | 353.5 (435.4) | 157.3 (147.5) | 16.1 (87.6) |
  | 64 MB | 63,693 (70,683) | 201.6 (206.7) | 18.3 (105.9) |

  A shared buffer that crosses once per call costs about as much as an empty call at the median. Occasional slow calls raise its mean several times above the median.

## Confirmation

- The user accepted this decision on 2026-11-16 by answering the Agent's question. Of the two ways for a provider to move its result, the user chose `call.transfer(...)` over a `transfer(value, buffers)` wrapper.
