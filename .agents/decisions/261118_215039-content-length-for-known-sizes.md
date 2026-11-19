# Decision: Content-Length for every response body of known size, without Bun's slow path

Status: accepted

## Background

- [Panel responses no slower than the main-thread panel](261118_195832-faster-panel-responses.md#bodies-of-14-kib-and-more) hands a response body of 14 KiB or more to Bun as a stream of one chunk, which Bun sends chunked, without `Content-Length`. It did so to avoid a slow path in Bun whose cause it didn't know.
- Devices that answer HTTP themselves with `ctx.serve` meet the same slow path: a body of bytes over about 15 KiB, answered after an `await`, runs several times slower.
- On 2026-11-18 the user asked for both to change:
  - "For the Content-Length issue, my understanding is that only responses of undetermined size should omit that header. If the size is already known, the response should include it — but it can still be transferred in chunks, progressively."
  - "The slowdown for bodies over 15 KiB needs to be fixed."
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - maintainability, since one function builds the fast form, for the panel and for every device;
  - observability, since a client sees the size of every body whose size is known, for its progress, its caches, and its checks of a complete transfer;
  - extensibility, since a device that serves HTTP itself gets the panel's speed with one function.

### Evidence

Measured on 2026-11-18 on the local machine, with the setup of [the earlier evidence](261118_195832-faster-panel-responses.md#evidence): Bun 1.4.4, a server pinned to cores 8 to 13 that answered after a `setTimeout`, and 3 client processes of 64 keep-alive clients each on cores 16 to 27, for 3 s per run. The probe scripts stayed outside the repository.

- **The cause.** Bun's `do_render_blob`, in `src/runtime/server/RequestContext.rs` at the tag `bun-v1.4.4`, corks the socket for a response that comes after its handler returned a promise only when the body is under 16 384 − 1 024 = 15 360 bytes. For a larger body it writes the head uncorked, and every piece of the head becomes a `sendto` of its own: the status line in three, each header in four, and `Content-Length` in three.
  - Under `strace`, the server made one `sendto` per response for bodies of 15 000 bytes, and 15 per response for bodies of 16 384 bytes, of which most carried 2 to 29 bytes.
  - Bun's `main` had the same code on 2026-11-18, and 1.4.4 was Bun's latest release.
- **A form that Bun sends with `Content-Length`, in one write.** Bun writes a stream's head corked and runs a direct stream's `pull` inside that cork. Its response sink buffers writes below the stream's `highWaterMark`, which it takes from the queuing strategy, and a stream that ends before anything went out is sent with uWebSockets' `tryEnd`, which writes `Content-Length`. So a direct stream whose `highWaterMark` is larger than its body, and whose `pull` writes the body and ends, goes out with `Content-Length`, in one `sendto` with its head.
  - Its bodies of 15 000 bytes, 16 KiB, 1 MiB, and 16 MiB arrived intact, each with its `Content-Length`.
  - A client that read a body of 16 MiB at 4 MiB/s received all of it in 3.5 s, while the server used no CPU time. A client that left after 1 s didn't disturb the next request.
- **Throughput,** one run of each:

  | Body | Bytes | Stream of one chunk | Direct stream with its length |
  |---|---:|---:|---:|
  | 4 KiB | 90 985 requests/s | 78 425 requests/s | 82 618 requests/s |
  | 14 KiB | 73 662 requests/s | 69 376 requests/s | 70 858 requests/s |
  | 16 KiB | 11 620 requests/s | 63 102 requests/s | 67 696 requests/s |
  | 64 KiB | 9 711 requests/s | 29 342 requests/s | 34 630 requests/s |
  | 256 KiB | 6 414 requests/s | 11 882 requests/s | 12 051 requests/s |
  | 1 MiB | 2 691 requests/s | 3 543 requests/s | 3 437 requests/s |
  | 4 MiB | 768 requests/s | 866 requests/s | 861 requests/s |
  | 16 MiB | 75 requests/s | 68 requests/s | 91 requests/s |

- **What differs from bytes.** Bun gives bytes a `Content-Type` of `application/octet-stream`, and a string `text/plain;charset=utf-8`, but a stream none. It answers `HEAD` for bytes with their `Content-Length`, and for a stream with `Transfer-Encoding: chunked` and no length.
- **Nothing tells the listener host which bodies are in memory.** A device's `Response` shows no difference between a body of bytes and a stream: its `body` is a `ReadableStream` either way, with the same properties. Its `blob()` settles at once for bytes, but starts reading a stream, which may never end.
- **Streams of a known length.** Bun sends every JavaScript stream chunked, and drops a `Content-Length` the response names. Only a stream that ends before anything went out gets a length, as above. So Bun 1.4.4 can't send a stream progressively with its length, though HTTP allows it, and Bun does it for files.

## Decision

### Bodies in memory

- A response body of bytes or text, whose size is known, goes out with `Content-Length`:
  - below 15 KiB, 15 360 bytes, as the body itself, which Bun corks;
  - from 15 KiB on, as a direct stream whose `highWaterMark` is one byte larger than the body, and whose `pull` writes the body and ends.
- The answer to a `HEAD` request keeps the body itself at every size, so it has the `Content-Length` that a `GET` would have.
- A response without a `Content-Type` gets the one Bun gives the same body: `application/octet-stream` for bytes, and `text/plain;charset=utf-8` for text. So a response's headers don't depend on its size.

### wholeResponse

- `rack42u` exports `wholeResponse(request, body, init?)`, which builds that `Response` from `body`, a `Uint8Array`, an `ArrayBuffer`, a string, or `null`, with the status and headers of `init`, for the method of `request`.
- A device that answers with `ctx.serve` after an `await` uses it in place of `new Response(body, init)` for a body in memory. `new Response()` keeps working as before, slower from 15 KiB on.
- The panel answers with it for every response body sent whole, in place of the stream of one chunk.

### Streams

- A stream goes out chunked, progressively, without `Content-Length`, even when its device names one: Bun can't send a stream with its length.
- `httpHandler` reads a body that ends at once within its `streamThreshold`, 16 MiB by default, and the panel sends it whole, with `Content-Length`, as before.

### Failure modes

| Failure | Outcome |
|---|---|
| A later Bun sends the direct stream chunked | the tests of `Content-Length` fail on every system before a release, and a new decision chooses again |
| A later Bun corks every head | the direct stream stays correct; a new decision can drop it |
| A client reads a large body slowly | Bun holds the body and writes it as the client reads, as it does for bytes |
| A client leaves during the body | Bun drops the body, as it does for bytes |

### Bounds

| What | Bound |
|---|---|
| A body sent as a direct stream | held once by Bun, at its own size, as Bun holds a body of bytes |
| A body sent whole through the panel | `httpHandler`'s `streamThreshold`, 16 MiB by default, unchanged |

### Observation

- Every response body of known size has its `Content-Length`. The README states which responses go out chunked: streams.

### Tests

- `wholeResponse`: bodies of 15 359 and 15 360 bytes, as bytes and as text, arrive intact with their `Content-Length` and without `Transfer-Encoding`; the answer to `HEAD` has the `Content-Length` of its body; the default `Content-Type` of each, and one that `init` names; the status and headers of `init`; a `null` body.
- Through the panel: response bodies of 14 KiB, 15 KiB, and 16 MiB arrive intact with their `Content-Length`; `HEAD` keeps it; a stream that doesn't end at once goes out chunked.
- A device that answers with `ctx.serve` after an `await`, through `wholeResponse`, gives its body's `Content-Length`.
- The tests run on Linux, macOS, and Windows. They check the framing, not the speed.

## Alternatives

- **Keep the stream of one chunk:** as fast, but a body of known size loses its `Content-Length`, which the user rejected.
- **Bytes at every size:** `Content-Length`, but Bun's slow path, five times slower at 16 KiB than this decision's form.
- **Replace `Response` in every device's Worker, so that the host knows each body:** automatic, but it changes a global the device's code relies on, every response pays for it, and responses from `fetch()` and `Response.json()` escape it.
- **Read a device's body in the listener host to learn its kind:** a stream may never end, and splitting it to look at it would slow every streamed response.
- **Read a stream whose device names its length, up to 16 MiB, and send it whole:** it would have its `Content-Length`, but a client would get nothing until the whole body had arrived, which is what streaming avoids. Beyond 16 MiB it can't work.
- **Write HTTP on `Bun.listen` instead of `Bun.serve`:** parsing, TLS, and WebSocket would be the rack's own, far beyond the gain.
- **Wait for Bun:** no release fixes it.

## Impact

- [Panel responses no slower than the main-thread panel](261118_195832-faster-panel-responses.md#bodies-of-14-kib-and-more): its bodies of 14 KiB and more, sent chunked, give way to this decision. It stays, with this note, and this decision comes first where they differ.
- What clients see: panel responses of 14 KiB and more regain `Content-Length` and lose chunked encoding, as before 2026-11-18. A response without a `Content-Type` gets Bun's default at every size.
- The public API gains `wholeResponse` in `rack42u`. Nothing breaks: `new Response()` works as before.
- The README: the HTTP panel section's note on chunked encoding, and a note in "Listeners" on `wholeResponse` and Bun's slow path.
- Follow-up work once this decision is accepted:
  - `wholeResponse` in `src/listeners.ts`, exported from `src/index.ts`, and the panel's responses in `src/std/http-panel.ts`.
  - The tests of [Tests](#tests), in `test/listeners.test.ts` and `test/http-panel.test.ts`.
  - With the user's approval, a report of the slow path to Bun.

## Confirmation

- The user accepted this decision on 2026-11-18, after reviewing it: "Approved."
