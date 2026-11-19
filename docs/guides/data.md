# Binary data and streams

Calls and events copy their data from one Worker to the next. For large binary data, a device can move the data or share it instead.

## Moving buffers

**Moving** an `ArrayBuffer` hands its memory to the other side without a copy, and the devices stay fully isolated: the sender's buffer is detached, and every view on it becomes empty. A caller lists the buffers to move in the `transfer` option of the call. A provider passes the buffers of its result to `call.transfer`:

```ts
// In connectors.ts: bytes can move in both directions.
export const Gzip = connector("acme.gzip/v1", {
  compress: rpc(v.object({ bytes: v.instance(Uint8Array) }), v.instance(Uint8Array)),
});

// In the provider's powerOn:
return {
  gzip: {
    compress({ bytes }, call) {
      const packed = Bun.gzipSync(bytes);
      call.transfer(packed.buffer); // the result moves to the caller
      return packed;
    },
  },
};

// In a device that needs Gzip. The call takes data.buffer, so data is empty afterward.
const packed = await ctx.ports.gzip.compress({ bytes: data }, { transfer: [data.buffer] });
```

- **When buffers are taken:** a call takes the buffers in `transfer` as soon as it is made, whatever its outcome. This includes a call that waits while its provider is swapped. A caller therefore cannot retry with the same buffers.
- **Calls from outside the rack:** `rack.call` takes the same option.
- **Invalid lists:** the call fails with `RACK_INVALID_INPUT`, and nothing is detached, when an entry is not an attached `ArrayBuffer`, is a `SharedArrayBuffer`, or appears twice.
- **Results:** the buffers passed to `call.transfer` are gone once the result is sent, even when the call fails. Passing a `SharedArrayBuffer` fails the call with `RACK_INVALID_OUTPUT`.
- **Events:** an event is copied or shared, never moved, because it goes to every subscriber.

## Sharing buffers

**Sharing** a `SharedArrayBuffer` gives every receiver the same memory, so nothing is copied. This works in the input or the result of a call, in an event, and with `rack.call`, and a typed array on a `SharedArrayBuffer` is shared too. Declare such a field with `v.instance(SharedArrayBuffer)`. The rack cannot see or order access to shared memory, so these rules are up to the devices:

- **A shared buffer belongs to the call that carries it.** The caller leaves it alone until the call succeeds. The provider neither keeps it nor uses it after returning.
- **Drop the buffer after a failed call.** After a call fails, times out, or is cancelled, do not reuse the buffer: the provider may still be running and writing to it.
- **Events are read-only.** A shared buffer in an event is read-only for the publisher and for every subscriber.
- **Do not keep a shared buffer as a channel.** Do not exchange data with another device through a kept buffer outside calls and events, such as a ring buffer or `Atomics.wait` and `Atomics.notify`. The backplane cannot hold or switch that traffic during a swap, and the new instance never gets the buffer. `Atomics.wait` also blocks the device's whole Worker.
- **Validate the bytes.** A schema checks that a buffer is there, not what it holds.

## Streams

A call can stream bytes instead of carrying them in one message, in its input, in its result, or both. In device code a stream is a standard `ReadableStream` of `Uint8Array` chunks, which a connector declares with `stream()`:

```ts
// In connectors.ts:
import { connector, rpc, stream } from "rack42u";
import * as v from "valibot";

export const Files = connector("acme.files/v1", {
  // Input: a name and the bytes to store. Output: the size and the bytes of a stored file.
  put: rpc(v.object({ name: v.string(), bytes: stream() }), v.number()),
  get: rpc(v.string(), v.object({ size: v.number(), bytes: stream() })),
});

// In a device that needs Files:
await ctx.ports.files.put({ name: "a.bin", bytes: Bun.file("a.bin").stream() });
const { bytes } = await ctx.ports.files.get("a.bin");
for await (const chunk of bytes) total += chunk.byteLength;
```

- **Where a stream goes:** a call carries at most one stream in its input and one in its output, as the value itself or as a top-level property of an object. The rack finds the stream by its value, so other schema libraries work too, such as zod's `z.instanceof(ReadableStream)`. A stream nested deeper, a second one, or one in an event payload can't be cloned, and fails as such a value does, with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
- **Flow control:** at most 256 KiB of a stream is in flight. The sending side reads its source only as fast as the reader takes chunks, so a slow reader slows the source. Each chunk is copied once and travels in pieces of at most 1 MiB, so the reader may get a large chunk as several pieces. A source keeps its buffers and may write into them again.
- **Timeouts:** a call whose input carries a stream times out from the end of that stream, so an upload doesn't time out while its bytes still move. Its provider sees `call.deadline` as `Infinity`. A stream fails with `RACK_TIMEOUT` at both ends when nothing moves on it for `streamTimeout`, a call option that defaults to the call's timeout.
- **Lifetimes:** a call takes its stream as soon as it is made, as it takes its `transfer` buffers. When the call fails before its provider reads the stream, the source is cancelled with `RACK_CANCELLED`. When a provider returns a result without a stream, the rest of its input is cancelled. When the result carries a stream, such as `input.pipeThrough(transform)`, the input stays open as long as that output stream.
- **Cancellation and errors:** a reader that cancels a stream cancels its source with `RACK_CANCELLED`, and the call's `signal` cancels its streams, also after the result has arrived. A source that fails errors the reader's stream with its error, after the pieces it sent before; a `RackError` keeps its code, and any other error becomes `RACK_DEVICE_FAULT`. A chunk that isn't a `Uint8Array` fails the stream at both ends with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
- **Swaps and faults:** the open streams of a device that is hot swapped go on until its old instance retires, at most `drainTimeout` after the switch, and then fail with `RACK_LINK_DOWN`. So a long-lived stream, such as server-sent events, doesn't hold a state handover. A cold swap or a restart cuts the streams once the calls have returned, with `RACK_LINK_DOWN`, and a crash or a watchdog bite fails them with `RACK_DEVICE_FAULT`.
- **Calls from outside the rack:** `rack.call` streams the same way, in both directions.
- **Counters:** in `rack.metrics()`, each RPC member whose calls carried streams gains `streams`, with `opened`, `open`, `bytesSent`, `bytesReceived`, and `errors` by code. `active` and `pending` count a call until its streams end, while `inFlight` in `status()` counts it until its result.
- **Limits:** the streams of a need are bounded by its unfinished calls, at most `queueLimit`, each with up to 256 KiB, or one piece of up to 1 MiB, in flight. With the defaults, that is about 2.4 GiB per need and direction, and up to 9.8 GiB in pieces of 1 MiB. Lower `queueLimit` for needs that can have many streams stalled at once.
