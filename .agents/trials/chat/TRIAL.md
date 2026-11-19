# Trial: chat

rack42u commit: 7dc1abaf4c1dc1efe6ccc749df8bc2ba153ee123

## Problems

### bun add reported success but left nothing on disk

- Doing: adding rack42u with `cd chat && bun add git+file:///home/zmmfly/prjs/rack42u#HEAD`, in a folder with no package.json
- Happened: Bun printed `installed rack42u@git+file://…#7dc1aba… with binaries: rack` and `1 package installed`, twice, but the folder had no package.json, bun.lock, or node_modules afterwards
- Expected: package.json, bun.lock and node_modules/rack42u to exist
- Fell short: trial setup (the getting-started guide says to create a package.json first, and CLAUDE.md of the trials does not)
- Where: docs/getting-started.md "Create the app" does say to make package.json first; the trials CLAUDE.md "Adding rack42u" skips that step, and Bun gave no warning
- Workaround: wrote package.json by hand with the pinned commit, then `bun install`, then `bun add valibot`; did not read rack42u's source
- Cost: slowed

### Reading the skill's files with Read and Bash was denied

- Doing: listing and reading `.claude/skills/rack42u`
- Happened: Bash `ls` and Read on that folder were denied by the permission mode
- Expected: to read the skill as CLAUDE.md says
- Fell short: trial setup
- Where: permissions of the trial
- Workaround: the Skill tool loaded SKILL.md, which was enough
- Cost: minor

### list() and restore() socket shape is not documented

- Doing: broadcasting to the sockets of a room from a device behind the HTTP panel, and keeping them across a swap
- Happened: docs/guides/http.md says to return `handler.list()` from `snapshot`, but not what it returns, nor that it can be used to find a room's sockets (the data given to `upgrade()` comes back in it). The API table only says "A socket and its data"
- Expected: the shape `{ socket: id, data }`, and a note that a device can broadcast with `ctx.emit.http.send({ socket: [ids], data })`
- Fell short: documentation
- Where: guides/http.md "WebSocket", reference/api.md `HttpSocketState`; a chat-like broadcast example is missing
- Workaround: read `node_modules/rack42u/src/std/http.ts` (HttpSocketState, HttpHandler); then used `list()` as the room membership and `ctx.emit.http.send` to broadcast
- Cost: slowed

### The result of swap() is not documented

- Doing: `await running.swap("chat", "./variants/chat-trim.ts")` in check.ts, expecting a result like `reload()`'s
- Happened: `swap` resolved with `undefined`; `JSON.stringify(results).includes` threw. The docs say `reload()` and `restart()` resolve with results, and say nothing of `swap()`'s return value; also that a relative `source` resolves against the base directory is not stated
- Expected: a documented return value and path rule
- Fell short: documentation
- Where: reference/api.md "The rack handle", `swap(name, source?)`
- Workaround: dropped the result check, and showed the swap took effect by the new device's behaviour; the relative path worked
- Cost: minor

### Typing a helper that takes a device's ctx

- Doing: sharing the message handling between two device files in `chat-core.ts`, passing `ctx` to a function
- Happened: no exported type for the ctx of a hook is named in the guides, so I wrote a structural type by hand and cast `ctx.emit.http` and `restore`'s state with `as never`
- Expected: a documented `DeviceContext`-style type, and `restore`'s state typed or a hint on narrowing it
- Fell short: documentation
- Where: reference/api.md lists `PortEmitter`, `PortClient`; guides/devices.md "The context" does not name the type
- Workaround: structural type with casts; did not read source
- Cost: minor

## Summary

- Works: `bun test` passes (6 tests: history and chat devices on the bench, each with its need stubbed). `bun check.ts` passes: 400 for bad names, two clients in a room and a third in another room, late joiner gets recent messages, too-long message refused to its sender only, `/rooms`, and after `swap("chat", "./variants/chat-trim.ts")` the clients stay connected, chat with the new behaviour, and a new joiner gets the recent messages. `PORT` sets the port, 3000 by default.
- Doesn't work: nothing known. Untested edge: a message sent while a client's `open` is still fetching history can arrive twice or before the history.
