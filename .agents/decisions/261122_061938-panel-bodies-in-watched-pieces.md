# Decision: Panel response bodies of 1 MiB or more go out in watched pieces, without Content-Length

Status: accepted

## Background

- [The fixes from the security review](261122_011655-security-review-fixes.md#the-http-panel-and-listeners) answer M6, a client that stops reading and so holds its whole response in memory with no time bound: "A response body of 1 MiB or more goes to the client in pieces that the panel watches."
- [Content-Length for every response body of known size](261118_215039-content-length-for-known-sizes.md#bodies-in-memory) gives every body in memory its `Content-Length`, at the user's request of 2026-11-18: "only responses of undetermined size should omit that header. If the size is already known, the response should include it — but it can still be transferred in chunks, progressively."
- Bun 1.4.4 can't do both, as that decision's evidence found, and as a probe on 2026-11-22 showed with a body of 64 MiB, to a client that read 1 MiB and then stopped reading:
  - A body of bytes, and a direct stream that writes it whole, go out with `Content-Length`. Nothing tells the panel how far the client got, and the panel can't end such a response: Bun's idle timer didn't fire within 8 s with `idleTimeout` 3, and Bun held the body.
  - A direct stream that writes it in pieces of 256 KiB, flushing each, went out chunked, and took all 64 MiB at once: its writes and flushes never held it back.
  - A stream that Bun pulls went out chunked, without the `Content-Length` that the response named. Bun pulled 23 pieces of 256 KiB, and no more while the client didn't read. So the pulls show how far the client got.
- The Agent reported the conflict on 2026-11-22, with two choices: watched pieces without `Content-Length` for bodies of 1 MiB or more, which it recommended, or `Content-Length` at every size with M6 stated as a limit. The user chose the first.

## Decision

### Bodies of 1 MiB or more

- Through the HTTP panel, a response body in memory of 1 MiB or more goes out as a stream of pieces of 256 KiB, which Bun pulls as the client reads, chunked and without `Content-Length`.
- The panel watches the pulls. When the client takes no piece for `idleTimeout`, the panel ends the response, so the client sees it end abruptly, and lets the body go.
- The log gets a warning, `a client stopped reading its response`, at the first such end, then at most one a minute, with how many came since, as for slow request bodies.
- A `HEAD` request for such a body gets the head that a `GET` gets: chunked, without `Content-Length`.
- A response without a `Content-Type` gets `application/octet-stream`, as a body sent whole does, so that its headers don't depend on its size beyond the length.

### What keeps its length

- A body under 1 MiB, as [Bodies in memory](261118_215039-content-length-for-known-sizes.md#bodies-in-memory) decides.
- A file that a device answers with through `fileResponse()`, which the panel sends from disk, at every size.
- The responses of a device's own listener, which `wholeResponse()` builds: this decision is the panel's only.

### Later Bun releases

When a Bun release can send a stream progressively with its `Content-Length`, a later decision can give these bodies their length back, still in watched pieces.

### Bounds and failures

| What | Bound or outcome |
|---|---|
| The size from which a body goes in pieces | 1 MiB, fixed |
| One piece | 256 KiB |
| A client that takes no piece | `idleTimeout`; then the response ends abruptly, and the body goes |
| A body that ends | Bun's idle timer for the connection is back, as after any response |

### Where this decision changes others

Each of these decisions stays, and this decision comes first where they differ:

- [Content-Length for every response body of known size](261118_215039-content-length-for-known-sizes.md#bodies-in-memory): through the panel, a body of 1 MiB or more loses its `Content-Length`.
- [Panel responses no slower than the main-thread panel](261118_195832-faster-panel-responses.md#responses-sent-whole): such a body goes out in pieces.
- [The fixes from the security review](261122_011655-security-review-fixes.md#the-http-panel-and-listeners): this is how the panel watches the pieces of M6.

## Alternatives

- **Keeping `Content-Length` at every size, and stating M6 as a limit, with a reverse proxy in front of a panel that faces the internet.** Every body would keep its length, but a client that stops reading would hold a body of up to 16 MiB for as long as it likes. Not chosen, by the user: reliability comes first among [the design goals](261117_062916-design-principles.md#goals).
- **A direct stream, which writes the body in pieces.** It shows no progress either: in the probe, its writes took 64 MiB at once. Not chosen.
- **A deadline for the whole body from its size and a lowest rate, as for request bodies.** A body that went out whole can't be ended by the panel, since no stream of its own is there to fail. Not chosen.

## Impact

- Clients of the panel get no `Content-Length` for bodies in memory of 1 MiB or more, such as a download without its size. A device that wants the length for such a body answers with a file, through `fileResponse()`.
- A client that stops reading such a body no longer holds it for good.
- Changed: `src/std/http-panel.ts`, its tests, the HTTP guide, and the limits table.

## Implementation

- `src/std/http-panel.ts`: `pieces()`, with `PIECES_FROM` and `PIECE`, which the panel's `handle()` answers with for a body in memory of `PIECES_FROM` or more, and `BYTES_TYPE`.
- Tests: in `test/http-panel.test.ts`, the heads of bodies below and from 1 MiB, `GET` and `HEAD`, and a client that stops reading a body of 16 MiB.
- Documentation: the HTTP guide's requests and observation, the limits table, and the skill.

## Confirmation

- The user chose this on 2026-11-22, after the Agent's report gave both choices and recommended this one: "Go with your recommendation for M6."
