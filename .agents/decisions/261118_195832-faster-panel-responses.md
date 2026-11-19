# Decision: Panel responses no slower than the main-thread panel

Status: accepted

## Background

- After [A configurable stream threshold, with bodies sent whole read by Bun](261118_165318-stream-threshold.md), the panel device still ran behind the main-thread panel it replaced:
  - at 0.95 to 0.99 of its rate for small requests, and for responses of 64 KiB and 256 KiB;
  - at about half its rate for responses of 1 MiB, which `httpHandler` streamed under its default `streamThreshold` of 256 KiB.
- On 2026-11-18 the user asked: "I think it's still a bit large. At the very least, it must not be worse than the old version."
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since every body stays bounded, at 16 MiB for a response sent whole;
  - maintainability, since the changes stay inside the panel, `httpHandler`, and the Worker host, with no new option;
  - observability, since the counters stay as they are, and the README states what a client sees;
  - extensibility, since devices behind a panel answer faster, with nothing to change in them.

### Evidence

Measured on 2026-11-18 on the local machine: Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores, Bun 1.4.4, with probe scripts outside the repository. The machine ran other work meanwhile, so the comparisons ran the old and the new setup in alternating pairs, with the rack pinned to cores 8 to 13 and the clients to cores 16 to 27, and give the median of the pairs' ratios. The load was 3 client processes of 64 keep-alive clients each, for 3 s per run.

- **A slow path in Bun for bodies of bytes.** A plain `Bun.serve` whose handler answered after a `setTimeout`, as a panel answers after its call:

  | Body | As bytes | As a stream of one chunk |
  |---|---:|---:|
  | 16 KiB | 10 721 requests/s, 17.7 ms | 62 243 requests/s, 3.1 ms |
  | 256 KiB | 6 045 requests/s, 31.8 ms | 12 130 requests/s, 15.8 ms |

  - The same responses, returned at once or after a microtask, ran at 75 000 to 80 000 per second at 16 KiB.
  - The cliff lies between bodies of 15 000 bytes, at 71 502 requests/s, and 15 360 bytes, at 11 308. A header of 4 KiB beside a body of 12 KiB stayed fast, so the body's size alone decides.
  - One connection at a time saw no delay: about 1.2 ms per request at every size, the timer's own.
  - The server's thread ran at 100% in both forms, so the slow path costs work, not waiting.
  - A `Content-Length` header, a `Blob` body, and a stream made from a `Blob` were as slow as bytes. Bun sent every other stream with chunked encoding, and dropped a `Content-Length` the response named.
  - The main-thread panel answered after its call too, so it ran on the slow path for every body over the cliff.
- **Streamed responses under load.** Through the panel, streamed responses of 4 MiB ran at 1 456 MiB/s over one connection, and at 768 to 1 024 MiB/s over 192. A body of 1 MiB to 16 MiB that ended at once moved at 2 356 to 2 521 MiB/s when sent whole, against 1 924 to 2 261 MiB/s for the main-thread panel.
- **Moving or copying a small body.** Per message at the receiving thread: a body of 2 bytes cost 1.3 µs copied and 1.7 µs moved; from 1 KiB, moving cost less. Every response reaches the panel's thread, the one that limits small requests.
- **Where the panel's thread spent its time** on small `GET`s, by JavaScriptCore's sampling profiler, apart from the call's `postMessage` and Bun's own work: a timer per call, 2.8%; an `AbortController` per request, 3%; its abort listener, 2.4%; the copies of the route parameters and of the input object, 2%; and a `setImmediate` per request.
- **A forwarding floor.** A device that only forwarded each request through `ctx.serve` and `http/v2` ran small `GET`s at 1.063 times the main-thread panel's rate, and 256 KiB responses at 0.973.
- **Batching link messages.** Two prototypes that sent the messages of one turn of the event loop on a link as one message lowered small `GET`s from about 52 600 to 39 600 and 44 500 requests per second.

## Decision

### Responses sent whole

- `httpHandler`'s default `streamThreshold` becomes 16 MiB, in place of the 256 KiB that [A configurable stream threshold](261118_165318-stream-threshold.md#the-threshold) set. A response body that ends at once within it goes back whole.
- The panel's own `streamThreshold`, for request bodies, stays 256 KiB: request bodies already ran faster than under the main-thread panel.
- So the panel holds a response body of up to 16 MiB until its client has read it, as the main-thread panel held every body. A larger one streams, so the panel holds at most 16 MiB per response.
- A source that produces its chunks without waiting, such as a generator, is read up to 16 MiB before its response streams.

### Bodies of 14 KiB and more

- The panel hands a response body of bytes of 14 KiB or more to Bun as a stream of one chunk, which avoids Bun's slow path. Bun sends it with chunked encoding, without `Content-Length`.
- The answer to a `HEAD` request keeps bytes, and with them its `Content-Length`, since it sends no body.
- Below 14 KiB, bytes are faster, and a response keeps its `Content-Length`.

### Failure modes

| Failure | Outcome |
|---|---|
| A device returns a body of up to 16 MiB that ends at once | it goes whole; the panel holds it until the client has read it |
| A client that reads a large body slowly | Bun holds the body as it would hold bytes, under the timer that the panel sets back when it answers |

### Bounds

| What | Bound |
|---|---|
| A response body sent whole | `httpHandler`'s `streamThreshold`, 16 MiB by default |

### Tests

- `httpHandler`'s default of 16 MiB: a body of 16 MiB goes whole, and one byte more streams.
- A response body of 1 KiB or more is moved, and a smaller one copied.
- Through the panel, a response body of 14 KiB minus one byte has its `Content-Length`; one of 14 KiB is chunked and arrives whole; the answer to `HEAD` keeps its `Content-Length`.
- A request that ends leaves its controller to the next request, which its client then cancels, with `RACK_CANCELLED` at the device.

## Alternatives

- **Keep bytes, with `Content-Length`, at every size**: what the main-thread panel did, and as slow as it from about 15 KiB on. The user chose the stream when asked, with the measurements and the loss of `Content-Length`.
- **Keep 256 KiB for responses**: a response of 1 MiB would stay at about half the main-thread panel's rate. The user chose 16 MiB when asked.
- **No limit for a response sent whole**: a body read from a file also ends at once, so a large file would be read into memory whole.
- **Send the messages of one turn on a link as one message**: slower in both prototypes.
- **Lift Bun's timer only for requests that wait longer than a tick**: 1% to 2% more small requests, but a request on a keep-alive connection that had idled could meet Bun's timer before the lift.

## Impact

- [A configurable stream threshold](261118_165318-stream-threshold.md#the-threshold): `httpHandler`'s default of 256 KiB gives way to this decision. It stays, with this note, and this decision comes first where they differ.
- The README: `httpHandler`'s default, and the chunked encoding of response bodies of 14 KiB or more.
- `src/std/http.ts` and `src/std/http-panel.ts`, with the tests in `test/http-panel.test.ts`.

## Implementation

- **Modules.**
  - `src/std/http.ts`: `STREAM_THRESHOLD` of 16 MiB, and `MOVE_FROM`, which moves only bodies of 1 KiB or more.
  - `src/std/http-panel.ts`: `ONE_CHUNK_FROM`, the stream of one chunk, and the same `MOVE_FROM` for request bodies.
- **Changes that keep every stated behavior**, which the evidence's profile pointed to:
  - `src/worker.ts`: the timeouts of calls run in one queue per timeout value, with one timer for the oldest call, in place of a timer per call; and a call listens to its signal as an `EventListenerObject`, with no closure per call.
  - `src/listeners.ts`: the handlers that arrive in one turn of the event loop share one `setImmediate` and one promise before they run, and the `Host` check remembers the last header that passed.
  - `src/std/http-panel.ts`:
    - The controllers of calls that ended without being aborted, while nothing else listened to them, serve later calls, up to 1 024 of them.
    - The bodies being read whole wait in one queue of deadlines with one timer, in place of a timer and a race per body.
    - A request's records are one object, the route parameters go into the call without a copy, and the headers are listed by spreading them.
    - A body sent whole is told by its declared length, without reading `request.body`, for which Bun would build a stream that `bytes()` doesn't use.
    - Only a `GET` is checked for a WebSocket upgrade, as RFC 6455 allows no other method.
- **Benchmark,** with the setup of [Evidence](#evidence): the old setup is the main-thread panel at `f7e772c`, which copied every body; the new one is this decision's panel device with its defaults. The device answered with `httpHandler`, from a buffer in memory for downloads. Each row gives the medians of the pairs and the median of their ratios.

  | Scenario | Main-thread panel | Panel device | Ratio |
  |---|---:|---:|---:|
  | `GET`, a 2-byte response | 52 598 requests/s | 52 639 requests/s | 1.00 |
  | `POST` of 1 KiB | 45 182 requests/s | 45 970 requests/s | 1.01 |
  | `GET` of 4 KiB | 183 MiB/s | 185 MiB/s | 1.01 |
  | `GET` of 16 KiB | 162 MiB/s | 552 MiB/s | 3.44 |
  | `GET` of 64 KiB | 500 MiB/s | 1 177 MiB/s | 2.35 |
  | `GET` of 256 KiB | 1 131 MiB/s | 1 767 MiB/s | 1.57 |
  | `GET` of 1 MiB | 1 854 MiB/s | 2 326 MiB/s | 1.26 |
  | `GET` of 4 MiB | 2 187 MiB/s | 2 484 MiB/s | 1.14 |
  | `GET` of 16 MiB | 1 968 MiB/s | 2 483 MiB/s | 1.26 |
  | `POST` of 64 KiB | 1 369 MiB/s | 1 706 MiB/s | 1.24 |
  | `POST` of 256 KiB | 1 954 MiB/s | 2 582 MiB/s | 1.31 |
  | `POST` of 1 MiB, streamed | 1 481 MiB/s | 1 812 MiB/s | 1.24 |

  - The first three rows come from 8 pairs, after the last change to the panel's requests; the others from 4 pairs, before it, which only read request bodies faster.
  - Single pairs of the first three rows ranged from 0.97 to 1.05: the panel device serves small requests at the main-thread panel's rate, within the machine's noise.
  - A forwarding device that did only what a panel must, as [Evidence](#evidence) describes, served small `GET`s at 1.06 times the main-thread panel's rate. The rest of the panel's work, its limits, cancellation, WebSocket, and checks of hosts, costs about that.
- **Tests:** in `test/http-panel.test.ts`, the cases of [Tests](#tests).
- [Content-Length for every response body of known size, without Bun's slow path](261118_215039-content-length-for-known-sizes.md) replaced the stream of one chunk for bodies of 14 KiB and more: the panel answers with `wholeResponse()`, which keeps `Content-Length` at every size, and the test of [Tests](#tests) for chunked bodies changed with it.

## Confirmation

- On 2026-11-18 the user asked that the panel device be no slower than the main-thread panel.
- Asked on 2026-11-18, with the measurements, the user chose 16 MiB for `httpHandler`'s default, and streams of one chunk for response bodies of 14 KiB and more, without `Content-Length`.
- The Agent settled the details the user left to it: the 14 KiB limit, `HEAD`, and the changes that keep every stated behavior.
