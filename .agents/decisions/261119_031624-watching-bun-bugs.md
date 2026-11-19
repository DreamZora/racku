# Decision: Watching two Bun bugs before reporting them

Status: accepted

## Background

- rack42u works around two bugs of Bun 1.4.4:
  - Bun can report a module missing that is on disk, while Workers import new files of one directory at the same time. The Worker host imports a firmware bundle again when that happens, with `importFirmware` in `src/firmware.ts`, as the [Implementation](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#implementation) of the P0 decision records.
  - A response that comes after an `await`, with a body of 15 360 bytes or more, goes out with its head in 14 writes of its own, and runs several times slower. `wholeResponse()` sends such a body as a direct stream that Bun writes in one piece, as [Content-Length for every response body of known size, without Bun's slow path](261118_215039-content-length-for-known-sizes.md) decides.
- On 2026-11-19 the user asked for a record of both, ready to report, and chose to wait: "Check whether Bun already has corresponding issues, and write up the two bugs as a record. Don't file them yet; we'll watch for a while to see whether Bun fixes them."
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since a fix in Bun removes a cause that the retry only contains;
  - maintainability, since each workaround is code that exists only for a bug of Bun, and this record says what would let it go.

### What Bun has on 2026-11-19

- Searches of Bun's issues and pull requests, open and closed, by the error, the caches, the cork, and the size, found no issue for either bug, and the pull requests below.
- Bun 1.4.5, released on 2026-11-19, changes neither: its commits since 1.4.4 touch CI, the build, dependencies, zstd, and zlib. Bun's `main` has the same check in `do_render_blob` that day, and none of the pull requests below is merged.
- For the first bug, four open pull requests, all from Bun's bot `robobun`:
  - [#47336](https://github.com/oven-sh/bun/pull/47336), "resolver: keep the key of a busted folder, so a miss is retried after another thread's bust", opened on 2026-10-29, names the same cause, with a Worker among its cases.
  - [#48891](https://github.com/oven-sh/bun/pull/48891), "resolver: a busted directory listing keeps its slot and is refilled in place", opened on 2026-11-14, also makes a second bust answer true.
  - [#47634](https://github.com/oven-sh/bun/pull/47634) and the draft [#40279](https://github.com/oven-sh/bun/pull/40279) look up a missed module once more at a fresh generation, which would cover it too.
- For the second bug, [#41341](https://github.com/oven-sh/bun/pull/41341), "Cork every HttpResponse write so post-await responses leave in one send()", opened by `dylan-conway` on 2026-09-04 and unchanged since:
  - It corks `writeStatus`, `writeHeader`, `tryEnd`, and `end` in uWebSockets, and leaves the check in `do_render_blob` as it is.
  - Its measurements cover streams and `node:http`, not a body of bytes. It would likely fix this case too; that is untested.

### First bug: an import misses a file on disk while other Workers import new files

A report, in the sections of Bun's bug template.

**Title:** `import()` of a file that is on disk fails with "Cannot find module" while other Workers import new files of the same directory

#### What version of Bun is running?

1.4.4 (38afee6c8)

#### What platform is your computer?

Linux 7.0.0-43-generic x86_64, Ubuntu 26.04.1 LTS. The same error failed tests on Windows x64, on GitHub Actions.

#### What steps can reproduce the bug?

`worker.ts`:

```ts
// Imports each file URL it receives, and answers with the error if the import fails.
addEventListener("message", async (event: MessageEvent<string>) => {
  try {
    await import(event.data);
    postMessage(null);
  } catch (error) {
    postMessage(String(error));
  }
});
```

`main.ts`:

```ts
// Each round writes one new file per Worker into one directory, then has every Worker import
// its file at the same time. Every file is on disk before its import starts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "files");
mkdirSync(dir, { recursive: true });
const workers = Array.from({ length: 8 }, () => new Worker(join(import.meta.dir, "worker.ts")));
const ask = (worker: Worker, url: string) =>
  new Promise<string | null>((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.postMessage(url);
  });

let imports = 0;
let failed = 0;
for (let round = 0; round < 1000; round++) {
  const errors = await Promise.all(
    workers.map(async (worker, index) => {
      const path = join(dir, `m${round}-${index}.js`);
      await Bun.write(path, `export default ${round};\n`);
      return ask(worker, Bun.pathToFileURL(path).href);
    }),
  );
  imports += errors.length;
  for (const error of errors.filter((e) => e !== null)) {
    if (++failed <= 3) console.log(error);
  }
}
console.log(`${failed} of ${imports} imports failed`);
process.exit(0);
```

Run `bun main.ts`, and remove `files/` before running it again.

#### What is the expected behavior?

`0 of 8000 imports failed`: every file is on disk before its import starts.

#### What do you see instead?

Every run failed some imports: 10, 14, and 22 of 8000 in three runs. The first printed:

```
ResolveMessage: Cannot find module '/tmp/rack42u-repro1/files/m67-3.js' imported from /tmp/rack42u-repro1/worker.ts
ResolveMessage: Cannot find module '/tmp/rack42u-repro1/files/m241-0.js' imported from /tmp/rack42u-repro1/worker.ts
ResolveMessage: Cannot find module '/tmp/rack42u-repro1/files/m311-1.js' imported from /tmp/rack42u-repro1/worker.ts
10 of 8000 imports failed
```

#### Additional information

- With one Worker, no import failed: 0 of 8000. With 8 Workers and every file written before the first import, none failed either: 0 of 8000.
- In three runs of a variant whose Worker imports the same URL again right after a failure, 13, 20, and 23 imports failed, and the second `import()` loaded the file in all 56.
- On Windows, the error failed tests now and then in CI, where Workers import bundles that `Bun.build` has just written. At each failure, the file was on disk and in its directory's listing, and the next `import()` loaded it.
- The cause, as we read it at `bun-v1.4.4`:
  - `VirtualMachine::_resolve` (`src/jsc/VirtualMachine.rs`, lines 5335 to 5404) retries a miss once, and only when `Resolver::bust_dir_cache` answers true.
  - `bust_dir_cache` (`src/resolver/resolver.rs`, line 2479) answers whether removing the directory from the process-wide caches of listings and `DirInfo` removed anything.
  - When two threads miss in the same directory, the second bust removes nothing, answers false, and that thread's miss is final.
  - #47336 describes this cause.
- Workaround: import again when the error's `code` is `ERR_MODULE_NOT_FOUND`, its `specifier` is the file itself, and the file exists.

### Second bug: the head of a response after an await goes out in 14 writes

A report, in the sections of Bun's bug template.

**Title:** Bun.serve: a `Response` of 15 360 bytes or more, returned after an `await`, writes its head in 14 `sendto` calls and runs several times slower

#### What version of Bun is running?

1.4.4 (38afee6c8)

#### What platform is your computer?

Linux 7.0.0-43-generic x86_64, Ubuntu 26.04.1 LTS

#### What steps can reproduce the bug?

`server.ts`:

```ts
// Answers every request with a body of the size given on the command line, after a timer,
// as a handler that awaits a database or another service would.
const size = Number(process.argv[2]);
const body = new Uint8Array(size).fill(120);
Bun.serve({
  port: 3000,
  async fetch() {
    await Bun.sleep(1);
    return new Response(body);
  },
});
```

```sh
# Terminal 1
strace -f -qq -e trace=sendto -o trace.txt bun server.ts 16384
# Terminal 2: 20 requests on one connection
curl -s $(for i in $(seq 20); do printf -- '-o /dev/null http://127.0.0.1:3000/ '; done)
# Terminal 1: stop the server with Ctrl-C, then count the writes to the client
grep -c MSG_NOSIGNAL trace.txt
```

#### What is the expected behavior?

One `sendto` per response, as below 15 360 bytes, or at most two, the head and the body, as the comment in `do_render_blob` expects.

#### What do you see instead?

| Body | `sendto` calls for 20 responses |
|---:|---:|
| 15 000 bytes | 20 |
| 15 359 bytes | 20 |
| 15 360 bytes | 300 |
| 16 384 bytes | 300 |

From 15 360 bytes on, each response takes 15 calls: 14 for the pieces of its head, then one for the body. The pieces are `HTTP/1.1 `, `200 OK`, `\r\n`, `content-type`, `: `, `application/octet-stream`, `\r\n`, `Date`, `: `, the date, `\r\n`, `Content-Length: `, the length, and `\r\n\r\n`, of 2 to 29 bytes each.

Throughput, measured on 2026-11-18 with the server on 6 pinned cores answering after a `setTimeout`, and 3 client processes of 64 keep-alive connections each on other cores, 3 s per run:

| Body | `new Response(bytes)` | The workaround below |
|---:|---:|---:|
| 14 KiB | 73 662 requests/s | 70 858 requests/s |
| 16 KiB | 11 620 requests/s | 67 696 requests/s |
| 64 KiB | 9 711 requests/s | 34 630 requests/s |
| 256 KiB | 6 414 requests/s | 12 051 requests/s |

#### Additional information

- The cause, as we read it: `do_render_blob` in `src/runtime/server/RequestContext.rs`, line 3511 at `bun-v1.4.4` and line 3304 on `main` on 2026-11-19, corks only small bodies:

  ```rust
  // We are not corked
  // The body is small
  // Faster to do the memcpy than to do the two network calls
  // We are not streaming
  // This is an important performance optimization
  if self.flags.has_abort_handler() && self.blob.get().fast_size() < 16384 - 1024 {
  ```

  Without the cork, uWebSockets sends each piece of the head with a call of its own, so a larger body costs 15 network calls, not the two the comment expects.
- #41341 corks every write of `HttpResponse`, and would likely fix it.
- Workaround: send the body as a `ReadableStream` of `type: "direct"`, with a `highWaterMark` larger than the body, whose `pull` writes the body and ends. Bun writes it with its head and `Content-Length` in one `sendto`.

## Decision

### Not reported yet

- Neither bug is reported to Bun, as the user decided. The Agent files no issue and comments on no pull request in Bun's tracker without the user's word.
- The two reports above are ready to file. Before one is filed, its reproduction runs again with the Bun release of that day, and the report takes the new results.

### The workarounds stay

- `importFirmware` keeps its further attempts, and `wholeResponse()` its direct stream from 15 KiB on, while rack42u supports a Bun release that has the bug.
- `wholeResponse()` stays public either way: a fix in Bun would only let its direct stream go.

### Watching

- When the user asks, and when work moves rack42u to a newer Bun release, the Agent reads the state of the pull requests above, runs both reproductions with that release, and tells the user what changed.
- When a Bun release fixes a bug, a new decision decides whether rack42u requires that release, and whether the workaround goes.
- The reproductions stay in this record, not in the tests: they test Bun. The tests of rack42u already hold each workaround to its behavior: `test/firmware.test.ts` for the further imports, and the `Content-Length` tests of `test/http-panel.test.ts` and `test/listeners.test.ts` for the direct stream.

### Until 2027-01-19

- The watch lasts until 2027-01-19. Then the Agent runs both reproductions again and brings the reports back to the user, who decides whether to file them.

## Alternatives

- **Report both now.** The user chose to watch first. Open pull requests already address both causes, so a report now would mostly point at them.
- **Comment on the pull requests, such as with the case of bytes on #41341.** That is a report too, which the user chose to hold.
- **Drop the workarounds and wait for Bun.** The race fails device starts now and then, and the slow path makes a response of 16 KiB nearly six times slower.
- **Require a Bun build that has the fixes.** None is released.

## Impact

- No change to code, tests, or the README.
- `AGENTS.md`: a line under "Current state" that names this record.
- Follow-up: when a reproduction stops failing with a Bun release, a decision on that release.

## Implementation

- `AGENTS.md` names this record under "Current state", after the minimum Bun version.

## Confirmation

- The user accepted this decision on 2026-11-19, after reviewing it, with the watch until 2027-01-19 that it proposed: "Accept".
