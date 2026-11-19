# Trial: files

rack42u commit: 7dc1abaf4c1dc1efe6ccc749df8bc2ba153ee123

## Problems

### bun add with no package.json installs nothing, and says it did

- Doing: adding rack42u, as CLAUDE.md says, with `bun add git+file://...#HEAD`, first in the trials folder (the shell's cwd), then in `files/`.
- Happened: `bun add` printed `installed rack42u@git+file:///home/zmmfly/prjs/rack42u#7dc1aba... with binaries: - rack` and `done` in 1 ms, but wrote no package.json and no node_modules in `files/`. Only after I wrote a `package.json` by hand did it install. The first run was in the trials folder and changed that folder instead; I undid it with `bun remove rack42u`.
- Expected: either a package.json made in my app's folder, or an error.
- Fell short: trial setup
- Where: the trials CLAUDE.md "Adding rack42u" doesn't say to create `package.json` first, nor that the shell's cwd is the trials folder, not the app's. (getting-started.md does say "Create the app" with a package.json.)
- Workaround: wrote package.json, ran `cd files && bun add ...`, pinned the commit by hand. Did not read rack42u's source.
- Cost: slowed

### A 50 MiB download can have a Content-Length only from a listener of the device itself

- Doing: serving `GET /files/<name>` through the HTTP panel, as the spec wants a `Content-Length` and no 50 MiB body in memory.
- Happened: http.md says a response body over httpHandler's `streamThreshold` (16 MiB) streams, "without Content-Length, even when the device names one"; raising the threshold to 64 MiB would send the file whole, so it would sit in memory. I confirmed with plain `Bun.serve` that a `ReadableStream` response with an explicit `content-length` goes out chunked too.
- Expected: a way to send a large stored file through the panel with its length.
- Fell short: the API
- Where: The HTTP panel (guides/http.md, "Requests"): no way to give a streamed or file-backed response a length. Listeners (guides/listeners.md) was the way out, but a length there needs `new Response(Bun.file(path))`, hence the path of a file.
- Workaround: the `web` device opens its own listener with `ctx.serve()`, not the panel, and `store` (the one writer) has a `locate` member that answers the file's path, so `web` answers `new Response(Bun.file(path))`. Reading by path steps around the backplane, and web must see the same disk. No source read.
- Cost: slowed

### Stubs read a stream whole, up to 16 MiB

- Doing: testing the 50 MiB limit of the devices on the bench.
- Happened: testing.md says a stream in a stub call crosses read whole, up to 16 MiB, so a 50 MiB upload can't go through a stubbed need on the bench.
- Expected: a way to test a size limit as it is.
- Fell short: documentation
- Where: Testing a device, "Stubs": nothing says how to test a limit above 16 MiB.
- Workaround: the limit is a `maxSize` config of both devices, so the unit tests use limits of a few bytes; the 50 MiB cases are in check.ts. No source read.
- Cost: minor

### The trial's command limits are uneven

- Doing: reading the skill and the folder, and running bun from the app folder.
- Happened: `Read` of `.claude/skills/rack42u/SKILL.md` and plain `ls` were denied; `bun -e` could list directories; some compound commands (`cd dir; ls`, `$?`, `PIPESTATUS`, `bun -e` with a long script) were denied, while `cd dir && bun ...` worked. `bun add --cwd <dir>` printed success but wrote nowhere.
- Expected: the commands CLAUDE.md lists to work in any form.
- Fell short: trial setup
- Where: CLAUDE.md "Commands".
- Workaround: `cd <app> && bun ...`, the Skill tool for the skill, `bun -e` for a listing, Edit/Write for files. No source read.
- Cost: minor

## Summary

- Works: the whole spec. `PUT`/`GET`/`DELETE`/list with 201, 204, 404, 400, 413; files of 1 KiB, 10 MiB, and 50 MiB uploaded as streams and downloaded with `Content-Length`, same size and hash; an upload over 50 MiB, declared or chunked, gets 413 and leaves no file; files survive a restart; `store`, the only writer, declares `swap: "cold"`, and both devices were changed while the app ran (check.ts swaps in a changed copy of each, then stores and serves). `PORT` and `FILES_DIR` come from the environment. `bun test` (9 tests) and `bun check.ts` pass.
- Doesn't work: nothing known. Limits: `web` uses its own listener and reads a file by the path `store` gives, not through the panel or the backplane; the hash of a file found after a restart is computed at its first list or download; an upload that replaces a file and then fails leaves the old file.
