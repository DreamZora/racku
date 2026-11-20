# Trial: files

rack42u commit: 6c958991d3f135c41977795751f09e773615902d

## Problems

### A bench or rack with a baseDir outside the app can't resolve the device's packages

- Doing: testing the device on the bench with a temporary directory in `os.tmpdir()` as `baseDir`, to keep test files away from the app
- Happened: `RackError: .../devices/files.ts: Cannot find package 'rack42u' imported from /tmp/files-test-iaMNfd/.rack/firmware/files-wrgg5nxe.js` (code `RACK_MANIFEST`)
- Expected: `baseDir` only says where relative paths resolve and where data goes; the docs for `baseDir` say nothing of module resolution
- Fell short: the documentation
- Where: `reference/api.md` start options (`baseDir`) and `guides/testing.md` bench options: neither says that the firmware is written under `<baseDir>/.rack/firmware/` and resolves the packages the device imports from there, so `baseDir` must lie inside the app (below its `node_modules`)
- Workaround: the base directory of the tests is a temporary folder inside the app's `scratch/`; I guessed the cause from the message and the firmware path, no source read
- Cost: minor

## Summary

- Works: one cold-swap device `files` with its own listener (PUT/GET/LIST/DELETE, name validation, streamed upload with a 50 MiB limit, 413 for declared and chunked bodies, files under `data/files/`); `bun test` (3 bench tests, 19 expects) and `bun check.ts` (rack start on a free port, 1 KiB/10 MiB/50 MiB round trips, 413, list, delete, 400 names, restart, `rack ctl swap` of the device) both pass.
- Doesn't work / not verified: the check doesn't measure memory, so "no 50 MiB in memory" rests on the code streaming (request body to file, `fileResponse` back); the bench can't reach the real 50 MiB limit through a stub, so the bench tests use a configurable small `maxSize`. During a cold swap connections are refused briefly (documented), so the check waits for the app to answer again. A single device means there is nothing to stub in `bun test`.
