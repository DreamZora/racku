# Decision: Byte streams in calls between devices

Status: accepted

## Background

- [Rack runtime architecture](261112_035942-rack-architecture.md#basic-units) says that the backplane "routes RPC calls, events, and streams". No stream mechanism exists. A call carries its input in one message and its result in another, each a structured clone, as [Backplane protocol with direct links between devices](261116_024226-backplane-links.md#rpc) decides.
- [Device and rack API](261112_043034-device-api.md#impact) says: "When a device handles a request through `http/v1`, both the request body and the response body are copied once in full; P0 does not support streaming."
  - The panel reads each request body with `request.arrayBuffer()` before it makes the call, in `src/panel.ts`.
  - `httpHandler` reads each response body with `response.arrayBuffer()`, in `src/http.ts`. Its JSDoc says that streaming is not supported.
- Full copies cost:
  - Memory that grows with the body. The panel holds the whole request, up to Bun's default limit of 128 MB, and the device holds the whole response, which has no limit.
  - Time to the first byte, which waits for the whole body. A body that never ends, such as server-sent events, can't be sent at all.
  - Backpressure. Nothing slows a fast source for a slow reader, so a download to a slow client is produced in full at once.
- Bun 1.4.4 can't pass a `ReadableStream` to a Worker, as [Evidence](#evidence) shows, so a stream can't simply travel inside a call.
- [Transfer and shared buffers for binary data](261116_213839-transfer-and-shared-buffers.md#impact) left for later that the HTTP panel could transfer request and response bodies.
- On 2026-11-18 the user asked for streaming bodies, and asked the Agent to research how to implement them while keeping performance good.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since each stream holds a bounded number of bytes, backpressure reaches the source, and every stall, cancellation, swap, and crash has a defined outcome;
  - maintainability, since one mechanism serves every connector, on the links and channels that exist;
  - observability, since the counters show the streams, their bytes, and their failures;
  - extensibility, since any connector can carry byte streams, not only HTTP.

### Evidence

Measured on 2026-11-18 on the local machine, Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores, with Bun 1.4.4. The probe scripts are not in the repository. None of these measurements ran on macOS or Windows, and each value comes from one run.

- **Passing a stream:** `postMessage(stream, [stream])` of a `ReadableStream` to a Worker threw `DataCloneError`, "The object can not be cloned."
- **Uploads into `Bun.serve`**, with the server in a Worker:
  - curl sent 64 MiB while the handler read one chunk of the request body every 25 ms.
  - The handler got 65 chunks of 46.5 KiB to 1.45 MiB. Each was the whole of its `ArrayBuffer`: offset 0, and as long as the buffer.
  - curl took 1.63 s, 39 MiB/s, as long as the reading took, so Bun slowed the client to the reader. The process's RSS rose from 24 MiB to 47 MiB.
  - With one chunk every 2 ms, the handler got 66 chunks, and curl took 0.14 s.
- **Downloads from `Bun.serve`:** a 64 MiB `ReadableStream` response, pulled 64 KiB at a time, went to curl limited to 8 MiB/s. After 2 s, the stream had been pulled 323 times, 20.2 MiB, about 4 MiB ahead of the 16 MiB that the client's rate let it read.
- **Moving 256 MiB from the main thread to a Worker** over a `MessagePort`, in MiB/s. The receiver only counted the bytes. A window is the most chunks sent and not yet acknowledged; in the runs with a window, the receiver acknowledged each chunk:

  | Chunk | Copied | Transferred | Transferred, window of 8 | Transferred, window of 32 |
  |---|---:|---:|---:|---:|
  | 16 KiB | 3,938 | 8,073 | 3,660 | 4,243 |
  | 64 KiB | 7,114 | 14,244 | 8,413 | 8,170 |
  | 256 KiB | 6,010 | 14,522 | 12,370 | 16,600 |

- **A `SharedArrayBuffer` ring with `Atomics`:** the writer copied each chunk into the ring, and the reader touched one byte of each batch it read. It moved 30,513 MiB/s with a 1 MiB ring and 64 KiB writes, and 34,011 MiB/s with a 4 MiB ring and 256 KiB writes.
- **Setting up a channel:** a new `MessageChannel` per stream, with its transfer to the Worker and one round trip, took 18 µs. A round trip on an existing channel took 9 µs.
- **A full copy:** a 16 MiB body copied to a Worker and back took 27 ms.
- For scale, a 1 Gbit/s network carries 119 MiB/s, and 10 Gbit/s carries 1,192 MiB/s.

## Decision

### Streams in calls

- The input or the output of an RPC call may carry a byte stream: the value itself, or a top-level property of an object value. A call carries at most one stream in its input and one in its output.
- In device code a stream is a standard `ReadableStream<Uint8Array>`, in both directions:

  ```ts
  import * as v from "valibot";
  import { connector, rpc, stream } from "rack42u";

  export const Files = connector("acme.files/v1", {
    // Input: a name and the bytes to store. Output: the bytes of a stored file.
    put: rpc(v.object({ name: v.string(), bytes: stream() }), v.number()),
    get: rpc(v.string(), v.object({ size: v.number(), bytes: stream() })),
  });

  // A consumer streams a file in, and another one out:
  await ctx.ports.files.put({ name: "a.bin", bytes: Bun.file("a.bin").stream() });
  const { bytes } = await ctx.ports.files.get("a.bin");
  let total = 0;
  for await (const chunk of bytes) total += chunk.byteLength;
  ```

- Connector schemas declare a stream with `stream()`, a new export of `rack42u`. It is a valibot schema that accepts a `ReadableStream`, for use inside valibot schemas such as `v.object`. With another schema library, a schema that accepts `ReadableStream` instances does the same, such as zod's `z.instanceof(ReadableStream)`.
- The rack finds a stream by its value, not by the schema, since a Standard Schema doesn't let the rack look inside an object schema. The schema only validates, as for any value.
- The provider validates its input and output as it does now. The input's stream is in place when the input is validated, and the output's stream is taken over after the output is validated.
- A chunk is a `Uint8Array`, `Buffer` included. Any other chunk fails the stream at both ends, with `RACK_INVALID_INPUT` for a stream in the input and `RACK_INVALID_OUTPUT` for one in the output.
- A stream nested deeper, a second stream in one direction, or a stream in an event payload or a snapshot can't be cloned. It fails as such a value does now: a call with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`, `emit` with `RACK_INVALID_OUTPUT`, and `snapshot` with `RACK_HOOK_FAILED`.
- Calls from outside the rack, through `rack.call()`, carry streams the same way.
- A call takes the streams it carries, as it takes its `transfer` buffers. When a call fails before its provider reads its input stream, for example at `queueLimit`, at a device that is down, or because its input fails validation, the rack cancels the stream at its source with `RACK_CANCELLED`. An output stream is cancelled the same way when its result fails validation, or when its caller has already given the call up, for example after its timeout.

### Transport

- A stream travels on the channel that carries its call: the call's link, or the data channel for a call from outside the rack. Its messages are multiplexed with calls by a stream id that is unique per channel and direction.
- Stream ids belong to their channel. A swap or a reset gives the new instance new links and a data channel of its own, so a message for a stream of an ended instance can't reach another instance.
- The call message, or the result, names the stream's position and id, and carries no stream itself.
- The link protocol and the data channel gain five messages. The sending end sends `chunk`, `end`, and `error`. The receiving end sends `credit` and `cancel`.
- The sending end copies each chunk into a buffer of its own, which then moves to the other end without a second copy. So a source keeps its buffers and may write into them again, as with any `ReadableStream`. A chunk never carries the rest of its buffer, and never shares memory with the other end, also when it is a view on a `SharedArrayBuffer`.
- A chunk over 1 MiB travels in pieces of at most 1 MiB, each copied into a buffer of its own.

### Flow control

- Flow control is by credit, in bytes, per stream.
  - The receiving end grants 256 KiB when the stream opens.
  - It returns credit for each chunk that its reader takes.
  - The sending end reads from its source only while it has credit. A chunk or piece larger than the credit left is sent only when nothing of that stream is in flight.
- So a stream has at most 256 KiB in flight, sent and not yet taken by its reader, or one piece of up to 1 MiB. The sending end holds at most one more chunk, the one it read and couldn't send yet.
- Backpressure reaches the source. A panel that streams a request body to a device reads from the client's connection only as fast as the device takes the bytes, and Bun then slows the client, as the upload probe measured on Linux.
- The window and the copy cost little next to a network. With acknowledgements per chunk, 8 transferred chunks of 16 KiB in flight still moved 3,660 MiB/s, about 30 times what a 1 Gbit/s network carries. Copied chunks of 16 KiB moved 3,938 MiB/s without a window. A 256 KiB window holds 16 such chunks. The copy and the window together were not measured; the benchmark in [Impact](#impact) measures them through the rack.

### Timeouts

- A call's timeout runs from the end of its input:
  - For a call without an input stream, from the moment it is made, as now.
  - For a call with one, from the moment that stream ends. So an upload doesn't time out while its bytes keep moving.
- A call with an input stream carries no deadline to its provider: `call.deadline` is `Infinity` there. The caller cancels the call when its timeout passes, and the provider aborts `call.signal`.
- Each stream has an idle timeout: a stream on which no chunk and no credit moved for that long fails with `RACK_TIMEOUT` at both ends.
  - `CallOptions` gains `streamTimeout`, in ms. It sets the idle timeout of the call's streams in both directions. By default it is the call's timeout, the rack's `callTimeout` of 30 s unless the call sets its own.
  - [The standard HTTP panel](261118_071513-http-panel-device.md) sets it to its own idle timeout.
- Once the result is sent, the call's timeout no longer applies. An output stream lasts until it ends, fails, is cancelled, or idles past its timeout.
- When the provider returns a result without a stream, the rack cancels whatever part of the input stream the implementation didn't read, with `RACK_CANCELLED` at the source.
- When the result carries a stream, the input stream stays open until that output stream ends, fails, or is cancelled, and the rack then cancels whatever part of it is unread. So a provider can return a stream that still reads its input, such as `input.pipeThrough(transform)`, and a response can start while its request body still arrives.
- A caller that doesn't want an output stream cancels it. Otherwise it holds its window until its idle timeout.

### Cancellation and errors

- A reader that cancels its stream cancels the source, with `RACK_CANCELLED`.
- A source that fails errors the reader's stream with its error. A `RackError` keeps its code, and any other error becomes `RACK_DEVICE_FAULT` with its message, as for calls.
- The caller's `signal` cancels the call's open streams, also after the result has arrived, with `RACK_CANCELLED` at both ends. The provider's `call.signal` aborts then too.
- When a channel goes down, its open streams fail at the end that remains, with the code its pending calls get: `RACK_DEVICE_FAULT` after a crash, a watchdog bite, or a hook that the instance didn't answer while it stopped, and `RACK_LINK_DOWN` when the rack ended the instance as planned. That is the rule of [Faults and resets](261116_024226-backplane-links.md#faults-and-resets), with the cases that [Watchdog](261117_062959-watchdog.md#biting) and [Ending instances and stuck threads](261117_185131-ending-instances.md#ending-an-instance) add.

### Swaps and resets

- A stream belongs to the instances at its two ends, and lasts at most as long as they do.
- A call that waits in a hold queue during a swap doesn't read its input stream until it goes out, since no receiving end grants credit before then. It counts toward `queueLimit` like any held call. Its stream moves nothing meanwhile, so the call fails with `RACK_TIMEOUT` once it has waited `streamTimeout`.
- A drain waits for the calls in flight to return, within `drainTimeout`, as now. For their streams:
  - When an instance retires after a hot swap, or is unplugged, or the rack stops, its open streams get until the end of its drain to end. Then they fail with `RACK_LINK_DOWN`.
  - Where the rack holds calls until the drain ends, open streams don't hold it: before a state handover, and in a cold swap, a restart, or a group replacement. The drain ends once the calls have returned.
  - After a state handover, the old instance's streams go on until it retires, as above. A long-lived stream, such as server-sent events, therefore doesn't hold a hot swap.
  - In a cold swap, a restart, or a group replacement, the old instance stops, and its open streams fail with `RACK_LINK_DOWN`.
- A long-lived stream through a device that swaps ends with `RACK_LINK_DOWN` at the latest at the end of the drain. Clients of server-sent events reconnect by themselves.
- A crash or a watchdog bite ends the instance's streams at once: they fail at the other end with `RACK_DEVICE_FAULT`, as its calls in flight do. So does an instance that the rack ends because it didn't answer a hook while it stopped.
- Requests that a device serves on its own listeners follow the same rules as calls with streams, as [Panels as devices, with listeners that survive swaps](261118_070617-panels-as-devices.md#when-listeners-listen) describes: a drain waits for their handlers to answer, and a response body that still streams then is treated as an open stream.

### Bounds

| What | Bound |
|---|---|
| Streams per call | one in the input and one in the output |
| Bytes in flight per stream | 256 KiB, or one piece of up to 1 MiB |
| Largest piece on the channel | 1 MiB |
| Open streams of a need | its unfinished calls, at most `queueLimit`, 10 000 by default: a call stays unfinished until its streams end |
| A stream without progress | `streamTimeout`, by default the call's timeout |
| The streams of an instance that retires | `drainTimeout` |

- Streams add no bound of bytes per need. A need's unfinished calls are bounded by count, as [Bounded backlogs instead of a breaker and thermal](261117_063228-bounded-backlogs.md#bounded-calls) decides, and each stream by its window. A builder whose needs can have many streams stalled at once lowers `queueLimit`.
- So the bound is loose. With the defaults, the streams of one need can hold 10 000 windows of 256 KiB in each direction, about 2.4 GiB, and up to about 9.8 GiB with pieces of 1 MiB. The README states this worst case. A later decision can cap the credit that an instance grants in total, which would slow streams instead of failing them.

### Failure modes

| Failure | Outcome |
|---|---|
| The reader is slower than the source | the source is read only as fast as the reader takes chunks |
| The reader cancels | the source is cancelled with `RACK_CANCELLED` |
| The source fails | the reader's stream errors with the source's code, or `RACK_DEVICE_FAULT` |
| The source produces a chunk that isn't bytes | the stream fails at both ends with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT` |
| The call fails before its provider reads the input stream | the input stream is cancelled with `RACK_CANCELLED` |
| Nothing moves for `streamTimeout` | the stream fails at both ends with `RACK_TIMEOUT` |
| The caller cancels the call | its streams fail at both ends with `RACK_CANCELLED` |
| The provider returns without a stream, before it read all of its input | the rest of the input is cancelled with `RACK_CANCELLED` |
| The output stream ends, fails, or is cancelled before the input it reads | the rest of the input is cancelled with `RACK_CANCELLED` |
| The instance at one end crashes, a watchdog bites, or it doesn't answer a hook while it stops | the other end's streams fail with `RACK_DEVICE_FAULT` |
| The instance at one end is ended as planned | the other end's streams fail with `RACK_LINK_DOWN` |
| A stream is still open when a drain ends | it fails with `RACK_LINK_DOWN` |

### Observation

- The counters of [Call and event metrics](261116_035534-call-metrics.md#reading) gain `streams`, on each RPC member whose calls carried streams, both for the members a device serves and for the ones it calls. The counters of calls from outside the rack gain it too:

  ```ts
  interface StreamMetrics {
    opened: number; // streams that the member's calls carried, in both directions
    open: number; // of them, the ones not ended yet
    bytesSent: number; // bytes this side sent on them
    bytesReceived: number; // bytes this side received on them
    errors: Record<string, number>; // streams that failed, by error code
  }
  ```

- `active` and `pending` count a call until its streams end, so they show open streams too. `ok`, `errors`, and `timeMs` still count a call at its result.
- `inFlight` in `status()` keeps counting a call until its result, as the drains do, so a drain before a state handover waits for results and not for streams, as [Swaps and resets](#swaps-and-resets) describes.
- Streams log nothing: one entry per stream would flood the log. Their failures count by code.

### Tests

- A slow reader: the source is read no faster than the reader takes chunks, and the bytes in flight stay within the window, checked at the sending end.
- A reader that cancels, a source that fails, a chunk that isn't bytes, and a stream that idles past `streamTimeout`, each with the outcome above at both ends.
- A chunk over 1 MiB arrives whole, in pieces of at most 1 MiB. A source that writes into a buffer again after it enqueued it doesn't change the chunk that the reader got, and no buffer at the source is detached.
- A call that fails before its provider reads its input stream, at `queueLimit`, at a device that is down, and with input that fails validation, cancels the stream at its source.
- A call with an input stream doesn't time out while the stream moves, and does once it has ended.
- A provider that returns early cancels the rest of its input. One that returns `input.pipeThrough(transform)` streams all of its input through, and a reader that cancels that output cancels the input too.
- A call held during a swap with an input stream: nothing is read until the call goes out.
- Swaps with open streams: a retiring instance's streams end or fail with `RACK_LINK_DOWN` at `drainTimeout`; a state handover isn't held by an open stream; a cold swap cuts the streams once the calls have returned.
- A crash and a watchdog bite at each end, and an end as planned, with the codes above.
- Streams nested deeper, two in one direction, and in events fail as values that can't be cloned.
- `rack.call()` with streams in both directions.
- The `streams` counters, and `active` and `pending` while a stream is open.

## Alternatives

- **Transfer the `ReadableStream` itself**: device code would see no difference. But Bun 1.4.4 can't do it.
- **One `MessageChannel` per stream**: each stream would get its own port, and the call's channel would carry no chunks. But a new channel cost 18 µs for setup and a first round trip, against 9 µs for a round trip on an existing channel. The rack would also have to track, hold, and close a port per stream.
- **`SharedArrayBuffer` rings**: the fastest in the probe, 30,513 MiB/s and more. But each stream would hold fixed memory, both ends would coordinate through `Atomics`, and the bytes would be copied into the ring and out of it. That gains nothing at network speeds. [Transfer and shared buffers for binary data](261116_213839-transfer-and-shared-buffers.md#shared-buffers) also rules out shared buffers as channels between devices.
- **Move a chunk that is the whole of its buffer without a copy**: twice the rate at 64 KiB in the probe, 14,244 MiB/s against 7,114. But a source that keeps a buffer it enqueued, such as a cache, would find it emptied, which an ordinary `ReadableStream` never does to it. At network speeds the copy costs little.
- **One RPC call per chunk**: no new messages. But each chunk would pay a call's overhead, with its validation and counters, and the consumer would have to put chunks back in order.
- **Keep full copies**: nothing to build. But memory grows with the body, the first byte waits for the last, server-sent events can't work, and nothing applies backpressure.
- **Find streams anywhere in a payload**: connectors could nest them. But every call would walk its whole payload, which [Transfer and shared buffers for binary data](261116_213839-transfer-and-shared-buffers.md#alternatives) rejected for buffers.
- **A window in chunks instead of bytes**: simpler to count. But chunks range from a few bytes to megabytes, so the memory a stream holds would depend on its source.
- **Run a call's timeout from the call, as now, also for calls with an input stream**: one rule for every call. But any upload that takes longer than the timeout would fail while its bytes still move.

## Impact

- The costs:
  - Each chunk costs a message, and each chunk the reader takes costs a credit message.
  - Each chunk is copied once, at the sending end.
  - Each stream holds up to 1 MiB in flight, and a long-lived stream ends at the end of a swap's drain.
- New public API: `stream()` in `rack42u`, `CallOptions.streamTimeout`, `StreamMetrics`, and streams in the input and output of calls. `call.deadline` is `Infinity` for a call with an input stream.
- How the accepted decisions this one affects are handled once it is accepted:
  - [Rack runtime architecture](261112_035942-rack-architecture.md#basic-units): this decision delivers the streams it names. It stays unchanged.
  - [Backplane protocol with direct links between devices](261116_024226-backplane-links.md#rpc): links and the data channel gain five messages, and a call with an input stream carries no deadline and times out from the end of its input. It stays as it is, with this note, as it did when [Bounded backlogs instead of a breaker and thermal](261117_063228-bounded-backlogs.md#impact) added the `taken` message.
  - [Device and rack API](261112_043034-device-api.md#impact): this decision provides the streaming that P0 left out. `CallOptions` gains `streamTimeout`, and `call.deadline`, a millisecond timestamp there, is `Infinity` for a call with an input stream. It stays, with this note. [The standard HTTP panel](261118_071513-http-panel-device.md) replaces its `http/v1`.
  - [Call and event metrics](261116_035534-call-metrics.md#reading): its counters gain `streams`, and `active` and `pending` count a call until its streams end. It stays, with this note, as it did when [Watchdog](261117_062959-watchdog.md#configuration-and-observation) added `loop`.
  - [Counters for calls from outside the rack](261117_185225-outside-call-metrics.md#decision): its counters gain `streams` the same way. It stays, with this note.
  - [Transfer and shared buffers for binary data](261116_213839-transfer-and-shared-buffers.md#transfer): a chunk is copied, and the copy moves as a transferred buffer does. Unlike a buffer that a call transfers, the chunk stays with its source, since a source may write into its buffers again, and unlike a shared buffer in a call, a chunk on a `SharedArrayBuffer` is copied too. It stays, with this note.
  - [Bounded backlogs instead of a breaker and thermal](261117_063228-bounded-backlogs.md#bounded-calls): `queueLimit` now also bounds open streams, since a call stays unfinished until its streams end. It stays, with this note.
  - [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) and [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md#cold-swaps): their drains treat open streams as [Swaps and resets](#swaps-and-resets) describes. Both stay, with this note.
  - [Design goals and principles](261117_062916-design-principles.md#impact): its gap "payload sizes are bounded only where a connector's schema bounds them" stays for calls. Streams bound the bytes in flight of each stream.
- The README gains a section on streams under "Connectors" or "Binary data", the `streamTimeout` option, the `streams` counters, and the worst case of bytes in flight that [Bounds](#bounds) states.
- Follow-up work once this decision is accepted:
  - Both ends of streams, flow control, timeouts, and counters in `src/worker.ts`, and for calls from outside the rack in `src/backplane.ts`.
  - The messages in `src/protocol.ts`, `stream()` in `src/connector.ts` or a module of its own, `streamTimeout` in `src/device.ts`, and `StreamMetrics` in `src/metrics.ts`.
  - The tests above, in a new `test/streams.test.ts`.
  - A benchmark through rack42u: one stream of 256 MiB between two devices, with chunks of 16 KiB, 64 KiB, and 256 KiB, recorded in `## Implementation`.

## Implementation

- **Modules.**
  - `src/streams.ts` holds both ends of a stream on one channel: `StreamChannel`, `StreamSender`, and `StreamReceiver`. It also holds `takeStream`, `putStream`, and `cancelStreams`, which find a stream at the top of a value, put it back, and cancel the ones a failed call carried.
  - `stream()` is in `src/connector.ts`, and `StreamMetrics` in `src/metrics.ts`.
  - `src/worker.ts` carries streams on links and on the data channel, and `src/backplane.ts` carries them for calls from outside the rack.
- **Messages,** in `src/protocol.ts`:
  - All five travel as one message type, `stream`, whose field `k` is `chunk`, `end`, `error`, `credit`, or `cancel`. A separate type was needed because `cancel` already names the cancel of a call.
  - A call carries `idle`, the stream timeout, and `stream`, the key and id of its input stream. A result carries `stream` for its output stream.
  - `drain` gains `streams`, which only the drains of a retirement and of `stop()` set. `drop` gains the error that the link's streams fail with.
- **Details the decision left open.**
  - A receiving end gives its reader the pieces that arrived before the source's error, then the error. Failures that the rack starts, such as a cancel, a timeout, or a lost channel, error the stream at once.
  - A reader that cancels with a `RackError` passes its code to the source; any other reason is `RACK_CANCELLED`.
  - Bun runs a timer whose delay is longer than 2³¹ − 1 ms, `Infinity` included, after 1 ms. So `armTimer` arms no timer for an infinite deadline, and caps longer ones. A call with `timeout: Infinity` therefore no longer fails after 1 ms.
- **Tests:** `test/streams.test.ts`, with the fixtures `test/fixtures/devices/streamer.ts`, `streamer-cold.ts`, and `stream-client.ts`.
- **Benchmark,** on 2026-11-18 on the local machine of [Evidence](#evidence), with Bun 1.4.4. It ran outside the repository.
  - One stream of 256 MiB went from one device to another. The provider's source enqueued one buffer again and again, since the sending end copies each chunk, and the consumer counted the bytes.
  - Five runs per chunk size, after a warm-up:

    | Chunk | Median | Runs |
    |---|---:|---|
    | 16 KiB | 2,198 MiB/s | 1,826 to 3,103 |
    | 64 KiB | 4,777 MiB/s | 4,597 to 5,036 |
    | 256 KiB | 4,813 MiB/s | 4,121 to 5,403 |

  - So a stream between devices carries 18 times what a 1 Gbit/s network carries at 16 KiB, and 4 times what 10 Gbit/s carries at 64 KiB.

## Confirmation

- The user accepted this decision on 2026-11-18. The user asked for streaming bodies, and left it to the Agent to research how to implement them while keeping performance good.
- The Agent chose to copy every chunk once, instead of moving whole buffers, so that a source keeps its buffers, and to keep an input stream open while the output stream that reads it lasts.
