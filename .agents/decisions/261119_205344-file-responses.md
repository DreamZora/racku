# Decision: Files that a device answers with, sent with their length

Status: accepted

## Background

- Issue #9, from the trial of the `files` app: a device behind the HTTP panel serves stored files, some of 50 MiB, and can't send them with their `Content-Length` without holding them in memory.
  - `httpHandler` reads a body that ends at once within its `streamThreshold`, 16 MiB by default, and the panel sends it whole, with its length. A larger body streams over the backplane, and the panel sends it chunked, without `Content-Length`, as [Content-Length for every response body of known size](261118_215039-content-length-for-known-sizes.md#streams) decides, since Bun can't send a JavaScript stream with its length.
  - Raising `streamThreshold` holds each file in memory, in the device and in the panel.
  - The trial's workaround: the device opens a listener of its own with `ctx.serve`, and answers `new Response(Bun.file(path))`, which Bun sends with its length. That leaves the panel's routes, TLS, and limits behind, and the device must see the same disk as the store that answers the file's path.
- A client needs the length for its progress, its caches, and its checks of a complete transfer, as the earlier decision says.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since a file goes out from disk as the client reads it, so memory stays bounded at every size;
  - observability, since a client sees the size of every file;
  - extensibility, since a device serves a file through the panel, or through its own listener, with one function.

## Evidence

Measured on 2026-11-19 with Bun 1.4.4 on Linux, with probe scripts outside the repository:

- `new Response(Bun.file(path))` from `Bun.serve` goes out with `content-length`, `content-type: application/octet-stream`, and `content-disposition: filename="<name>"`, which Bun adds from the file's name on disk. A `Content-Disposition` that the response sets replaces Bun's. A `HEAD` request gets the length without the body.
- A stream from `Bun.file(path).stream()` goes out with its length too. A stream that JavaScript code makes, such as the panel's stream of the backplane's chunks, goes out chunked, as the earlier decision measured.
- A file that is gone when Bun opens it fails the response after the handler returned: Bun answers 500 with an error page of its own.
- A `Response` of a file shows nothing of the file: its `body` is a `ReadableStream`, as for any body. Only `blob()` returns the file, with its path as `name`, and `blob()` reads any other kind of body to its end.
- The panel and the devices run in one process, so the panel can open every file that a device can name.

## Decision

### fileResponse

- `rack42u` exports `fileResponse(file, init?)`, beside `wholeResponse`. `file` is a path or a `BunFile`, and `init` takes the status and headers of `new Response()`.
  - It returns `new Response(Bun.file(path), init)`, so a device that answers through its own listener uses it too, and gets the length from Bun.
  - It sets `Content-Disposition: inline` unless `init` names one, so that a client doesn't see the file's name on disk.
  - It marks the response, so that `httpHandler` knows it for a file.
  - A relative path resolves against the process's working directory, as `Bun.file()` resolves it.
- `httpHandler` sends a file response through `http/v2` by its absolute path, with its status and headers, without reading the file. The body of `HttpResponse` gains a third form, `{ file: <absolute path> }`, beside bytes and a stream.
- The panel answers a file body with `new Response(Bun.file(path), { status, headers })`. Bun reads the file from disk as the client reads it, and sends it with its `Content-Length`, at every size. A `HEAD` request gets the length without the body.
- The connector stays `http/v2`: a panel and `httpHandler` come from the same rack42u in an app, and a device that implements `http/v2` without `httpHandler` never has to send the new form.

### Failure modes

| Failure | Outcome |
|---|---|
| The file is gone, or can't be read, when the panel opens it | the panel answers 502 with `RACK_DEVICE_FAULT`, as for any other error of the device, and logs the path |
| The file changes while it goes out | the client gets what Bun reads, as with any file that Bun sends; a device that replaces files writes the new one beside the old and renames it into place |
| `httpHandler` gets a file response for a `HEAD` request | it sends the file's path as for `GET`, and the panel answers with the length only |

### Bounds

| What | Bound |
|---|---|
| Memory for a file body | Bun's buffers only: Bun reads the file as the client reads it |
| Files the panel opens | those the rack's process can read and a device names; devices are the app's own code, which the panel trusts as it trusts their answers |

### Observation

- A client sees each file's `Content-Length`. The panel counts the call in `metrics()` as any other.
- The documentation of the HTTP panel and of listeners shows `fileResponse`, and says which responses go out chunked: streams that aren't files.

### Tests

- A device behind the panel answers a file of 50 MiB with `fileResponse`: the client gets its `Content-Length` and every byte, and a `HEAD` request gets the length alone.
- A device that answers through its own listener with `fileResponse` sends the length too.
- A file removed between the device's answer and the panel's response gets 502 with `RACK_DEVICE_FAULT`.
- A response without `Content-Disposition` goes out with `inline`, and one with its own keeps it.

## Alternatives

- **Raising `streamThreshold`.** It holds every file in memory, in the device and in the panel, so memory grows with the largest file.
- **A stream with a declared length.** Bun sends every JavaScript stream chunked and drops its length, so the panel can't send the backplane's stream with one.
- **Telling a file response apart without a helper.** A response of a file shows nothing of the file except through `blob()`, which reads every other kind of body to its end, so `httpHandler` can't know a file without reading.
- **The device's own listener,** the trial's workaround. It works today, but leaves the panel's routes, TLS, and limits behind.
- **Asking Bun to send streams with their length.** That would fix every stream, but it is outside rack42u's control and timing, and a report to Bun waits for the user's word.

## Impact

- Gains: files of every size go out through the panel with their length, from disk, in bounded memory; one function serves the panel and a device's own listener.
- Costs: `http/v2` gains a body form that every panel must handle, and the panel opens files that devices name.
- Follow-up: range requests, `206 Partial Content`, for file bodies, which a decision of its own can add.

## Confirmation

- The user accepted this decision on 2026-11-19, with the answers it proposed to its open questions: `fileResponse` in `rack42u`, beside `wholeResponse`, and `Content-Disposition: inline` by default. The user's words: "All approved — handle them in order."
