# Trial: files

racku commit: 76ec9c28a930ab6d0d6e6260980764cdaaddd616

## Problems

### `rejects.toMatchObject` on a RackError hangs a bench test

- Doing: testing that the store refuses a too-large upload, `await expect(store.call("files","put",{...})).rejects.toMatchObject({ code: "TOO_LARGE" })`
- Happened: the test timed out (5 s, and 30 s when raised); `bun test` then took 60 s to end. The same call caught with `.catch(e => e)` returns the RackError in 3 ms. The same `rejects.toMatchObject` on a `BAD_NAME` error (no stream in the call) passed.
- Expected: the assertion to pass like the other.
- Fell short: the documentation (testing.md shows no pattern for asserting an error from `call`; a Bun quirk may be involved, since memory says toMatchObject misbehaves)
- Where: guides/testing.md, "Members of a bench": no example of asserting that a call fails with a code
- Workaround: `.catch((e) => e)` and `expect(failure.code).toBe(...)`. I didn't read racku's source.
- Cost: slowed

### A comment-only change to a device doesn't swap it

- Doing: in check.ts, changing the store "while the app runs" by appending a comment, then `rack ctl reload`
- Happened: `rack ctl reload` printed `[]` and `rack ctl history` was empty: the firmware is identical, since the bundle drops comments.
- Expected: some report that nothing changed, or documentation saying so.
- Fell short: the documentation
- Where: guides/updates.md, `reload` / `ctl reload`: it doesn't say that a reload replaces only devices whose firmware (bundle) changed, so a comment-only edit is no change; `[]` isn't explained. (getting-started says "replaces only notes, whose firmware changed", which hints at it.)
- Workaround: change code (add a log line) instead
- Cost: minor

### A bench's base directory is not cleaned up

- Doing: running bench tests with a `baseDir` of my own under `scratch/`
- Happened: the directories (with `.rack/`, `data/`) stay after `stop()`; and a first attempt that `rm`-ed and recreated one fixed base directory for each test failed with `RACK_MANIFEST: ENOENT ... .rack/no-tsconfig.json...tmp` (the previous bench still wrote into it while stopping, or its remove raced mine).
- Expected: "Stop the rack and delete the bench's files" to say what it keeps; a fresh base per test to be the advised way.
- Fell short: the documentation
- Where: guides/testing.md, "The bench" paragraph on `baseDir`: no word on who removes it or on reuse between tests
- Workaround: one new directory per test, named by pid and a counter. Didn't read the source.
- Cost: minor

### Streaming an upload, a download with Content-Length, and a limit: pieces had to be put together

- Doing: finding how to stream 50 MiB in, and out with Content-Length, through the panel
- Happened: the pieces are in three places (data.md streams, http.md `maxBodySize` default 1 MiB and `fileResponse`, listeners.md files). Nothing says that a chunked upload over `maxBodySize` fails the device's stream, and I found by running that the panel answers 413 itself then (the log shows `RACK_INVALID_INPUT ... larger than maxBodySize`), so the device didn't need to map it.
- Expected: one example of a file store (upload stream in, `fileResponse` out), since it is a common app.
- Fell short: the documentation
- Where: guides/http.md#requests: the 413 row says a streamed body "fails at the device with RACK_INVALID_INPUT", yet the client got 413 in my run
- Workaround: tried it; works as the client needs. Downloads send the file's path back from the store (`stat`), and the web device calls `fileResponse(path)`, so the store's path crosses the backplane. No source read.
- Cost: minor

## Summary

- Works: PUT/GET/DELETE/list with the names rules; uploads stream through the HTTP panel into a cold-swapped `store` device (hash and size counted while writing, a temp file renamed at the end, none left after a 413); downloads leave from disk with Content-Length through `fileResponse`; files survive a restart; `rack ctl reload` after a code change of the store does a cold swap, and the app serves on; `bun test` (6 tests, store on the bench with the real limit set small, web with a stubbed store) and `bun check.ts` (1 KiB, 10 MiB, 50 MiB, over-limit declared and chunked, list, delete, names, restart, change while running) pass.
- Doesn't work: nothing known. Not tested: a swap during an upload in flight; memory use of the 50 MiB upload was not measured (streamed by design, never concatenated in app code). The web device's `maxBodySize` check of the declared length duplicates the panel's.
