# Decision: A configurable stream threshold, with bodies sent whole read by Bun

Status: accepted

## Background

- [The standard HTTP panel device, with WebSocket and TLS](261118_071513-http-panel-device.md#requests) fixes which bodies travel whole:
  - A request body with a declared length of at most 64 KiB travels as bytes, and larger and chunked bodies stream.
  - The panel reads a body it sends as bytes under the same idle timeout as a stream, and answers 408 when the client stops sending it.
  - Its implementation returns a response body as bytes when the body ends within one turn of the event loop and within 64 KiB.
- Its benchmark found the panel device 16% to 52% slower than the main-thread panel it replaced, depending on the scenario.
- On 2026-11-18 the user asked: "The body size threshold for streaming should be configurable—it can have a default, but it must not be fixed at 64 KiB. Try to optimize the new panel's performance before pushing feat/p3 and running CI".
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since every body stays bounded, by the threshold or by a stream's window, and a body sent whole has a deadline for its whole arrival;
  - maintainability, since the option is one number per side, with the same meaning on both;
  - observability, since the bodies that stream still show in the need's `streams` counters;
  - extensibility, since a builder sets the trade-off between memory and speed per panel and per device.

### Evidence

Measured on 2026-11-18 on the local machine: Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores, Bun 1.4.4, with probe scripts outside the repository. The loads were those of the panel decision's benchmark: 3 client processes, each with 64 keep-alive clients, for 3 s, one run each.

- **Where the panel's time went.** Under small `GET`s, the panel's Worker was the thread that saturated, at 100% of a core, with the device's Worker at 70%. JavaScriptCore's sampling profiler found, in the panel's Worker:
  - `postMessage` of the call: 26% of the samples;
  - `request.signal`, which Bun builds for each request that reads it, and `AbortSignal.any`: about 9%;
  - the call's `AbortController` and its abort listener: about 5%;
  - copying the listener's counters into shared memory, twice per request: about 3%.
- **A signal read late.** A `request.signal` that a handler read only 300 ms after its client went away came back aborted, both for a `fetch` client that aborted and for a raw socket that closed.
- **Reading a body of 1 KiB** in a plain `Bun.serve`:

  | How | Requests/s |
  |---|---:|
  | `request.bytes()` | 111,230 |
  | `request.arrayBuffer()` | 111,935 |
  | `Bun.readableStreamToBytes(request.body)` | 106,081 |
  | A reader in JavaScript | 48,472 |
  | A reader in JavaScript, with a timer per read, as the panel read | 44,628 |

  - Accessing `request.body` alone cost nothing measurable: 109,401 requests/s.
  - `request.bytes()` returned a view of a buffer of its own, at offset 0 and as long as the buffer, at every size tried from 1 byte to 300,000 bytes. A request with `Content-Length: 0` had a `null` body.
  - When a handler answered 408 while `request.bytes()` waited for the rest of a stalled client's body, Bun failed the read with "The connection was closed.", and the client received the 408.
- **Moving a body between Workers**, per `postMessage`: a clone of a `Uint8Array` cost 2.2 µs at 1 KiB, 13.1 µs at 64 KiB, 36.4 µs at 256 KiB, and 189 µs at 1 MiB; a transfer cost about 1 µs at every size.
- **Buffered response bodies.** A reader of `new Response(bytes)` got the first 16 KiB, then the rest in one chunk of up to 2 MiB. Read one after the other, each read settled within two microtask turns.
- **Streamed responses.** A plain `Bun.serve` sent 1 MiB responses at 4,967 MiB/s as a buffer and at 3,711 to 3,866 MiB/s as a stream.

## Decision

### The threshold

- `streamThreshold`, in bytes, decides which bodies travel whole and which stream, on each side for what it sends:
  - In the panel's configuration, for request bodies: a body with a declared length up to `streamThreshold` goes to the device as bytes. A larger one, and a chunked one, streams.
  - In `httpHandler({ fetch, streamThreshold })`, for response bodies: a body that ends at once within `streamThreshold` goes back as bytes. A larger one, or one that doesn't end at once, streams.
- Its default is 256 KiB on both sides, a stream's window:
  - A stream sends a body of up to one window without waiting for credit, so sending such a body whole holds no more bytes in flight, and saves the stream's messages.
  - A larger body streams by default, so that it holds at most a window in flight.
- It is an integer of 0 or more. With 0, every body that has bytes streams. A larger value sends larger bodies whole, which moved them faster in the benchmark, while each holds all of its bytes until the other side has taken them.
- A bad value in the panel's configuration fails the panel's boot with `RACK_INVALID_CONFIG`, as any bad field does. `httpHandler()` throws `RACK_INVALID_INPUT` for one.
- A body sent whole moves its buffer to the other Worker instead of copying it. The panel's request bodies and `httpHandler`'s response bodies are buffers of their own, which the call and the result transfer.

### Bodies sent whole

- The panel reads a request body that it sends whole with Bun's `request.bytes()`, which reads it natively. This replaces the reader in JavaScript, which served fewer than half the small requests in the evidence.
- `request.bytes()` shows no progress. So the bound on such a body changes from its idle time to its whole arrival: the body must arrive within `idleTimeout`, or the client gets 408 with `RACK_TIMEOUT`, "the client didn't send its body within idleTimeout".
- So a client must send the largest body that goes whole at `streamThreshold / idleTimeout` on average or faster: 25.6 KiB/s with the defaults. A deployment whose clients are slower raises `idleTimeout`, or lowers `streamThreshold`.
- The bound also stops a client that drips a small body, which the idle rule let hold its request as long as each byte came within `idleTimeout`. Bun's own timer bounded the whole exchange this way under the main-thread panel.
- A body that streams keeps the idle rule of the panel decision: it fails once it moves nothing for `idleTimeout`, in either direction.

### Cancellation

- The panel reads the client's signal only for a call that still waits for its response head at the second tick of a timer of 100 ms after the call started, so 100 ms to 200 ms after its start, or later when the panel's event loop is busy. Most calls answer before that, and a signal read late still reports a client that went away before.
- So a client that goes away cancels its call with `RACK_CANCELLED` at the device, as the panel decision says: once the panel has read its signal, at once.
- From the response head on, a client that goes away cancels the response's stream, which Bun does itself, and the stream's end cancels the call.

### Failure modes

| Failure | Outcome |
|---|---|
| A body sent whole that hasn't arrived within `idleTimeout` | 408 |
| A body that streams and moves nothing for `idleTimeout` | 408, as before |
| A client that goes away while its call waits for the head | the call is cancelled once the panel reads the client's signal, 100 ms to 200 ms after the call started |
| A bad `streamThreshold` | `RACK_INVALID_CONFIG` at the panel's boot; `RACK_INVALID_INPUT` from `httpHandler()` |

### Bounds

| What | Bound |
|---|---|
| A request body sent whole | `streamThreshold`, and `maxBodySize`; it arrives within `idleTimeout` |
| A response body sent whole | `streamThreshold` |
| Request bodies sent whole per route target | the need's `queueLimit` of unfinished calls, each with at most `streamThreshold`: 2.4 GiB with the defaults, as the streams of one need can hold |
| A body that streams | a stream's window in flight, as before |

### Observation

- Bodies that stream show in the need's `streams` counters, as before, and bodies sent whole don't.
- A 408 for a body sent whole counts nowhere, since no call reached a device, as the panel decision says for 408.

### Tests

- The defaults: `streamThreshold` of 256 KiB in the panel's configuration and in `httpHandler`.
- A request body at the panel's `streamThreshold` goes to the device as bytes, and one byte more streams.
- A response body within `httpHandler`'s `streamThreshold` goes back as bytes whose buffer the result moves, one byte more streams, and a body that doesn't end at once streams. A bad `streamThreshold` throws `RACK_INVALID_INPUT`.
- A client that keeps sending a body sent whole, slower than `idleTimeout` allows for the whole body, gets 408 once `idleTimeout` has passed. A chunked body that keeps moving for longer than `idleTimeout` succeeds.
- A client that goes away before the panel reads its signal still cancels its call, with `RACK_CANCELLED` at the device, on every system.
- The tests of the panel decision that pinned 64 KiB use `streamThreshold`.

## Alternatives

- **Keep 64 KiB fixed**: the user asked for a configuration item.
- **One threshold, in the panel, for both directions**: the panel can't choose how a device sends its response, so each side decides what it sends.
- **Default to `maxBodySize`, 1 MiB**: every request body within the default limit would go whole. But each would hold its whole body until its call ends, and its client would need 100 KiB/s to send 1 MiB within `idleTimeout`.
- **Keep the reader in JavaScript for bodies sent whole**: the idle rule of the panel decision stays. But small `POST`s stayed about 30% slower than under the main-thread panel. The user chose `request.bytes()` when asked, with its measured gain and the 408 rule it changes.
- **A deadline that grows with the declared length**: no minimum rate for clients. But it needs one more option, or a fixed rate that suits no deployment.
- **Several calls in one message**: the call's `postMessage` is the largest cost in the panel's Worker, and batching would cut the messages per request. But it changes the backplane's messages, which needs a decision of its own.
- **Merge the chunks read before a response starts streaming into one chunk**: 14% more 1 MiB responses in one run, since the stream then waits for credit once. But it copies those chunks once more, for one pattern of Bun's reads.

## Impact

- Behavior changes, within 0.4.0, which isn't released yet:
  - Request bodies of a declared length from 64 KiB to 256 KiB go to the device as bytes instead of streaming, and must arrive within `idleTimeout`. Devices on `httpHandler` see `request.body` either way; a device that implements `http/v2` by hand already takes both.
  - Response bodies from 64 KiB to 256 KiB that end at once go back as bytes.
- [The standard HTTP panel device](261118_071513-http-panel-device.md#requests): its 64 KiB rule, its idle rule for bodies sent as bytes, and its implementation note about response bodies within 64 KiB give way to this decision. It stays, with this note, and this decision comes first where they differ. Its implementation section follows the code, as implementation facts do.
- The README: the panel's configuration table, its Requests, and `httpHandler`'s option.
- `src/std/http-panel.ts`, `src/std/http.ts`, and `src/std/index.ts`, with the tests in `test/http-panel.test.ts` and a helper in `test/fixtures/net.ts`.

## Confirmation

- On 2026-11-18 the user asked for the threshold to be configurable, with a default that isn't fixed at 64 KiB, and for the panel to be optimized before `feat/p3` is pushed.
- Asked on 2026-11-18 whether the panel should read bodies sent whole with `request.bytes()`, with its measured gain and the change of the 408 rule from idle time to the whole body, the user chose to switch, with the default of 256 KiB.
- The Agent settled the details the user left to it: the option's name, its default on each side, `httpHandler`'s option, and the changes that keep every stated behavior.
