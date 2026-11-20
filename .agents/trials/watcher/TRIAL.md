# Trial: watcher

rack42u commit: 6c958991d3f135c41977795751f09e773615902d

## Problems

### Some shell forms were denied

- Doing: running `cd <dir> && pwd && ls ../ ...`, `PORT=0 timeout 6 bun watcher.ts`, `bun check.ts > file; rm file`, `bun check.ts; echo $?`, and `${PIPESTATUS[0]}`
- Happened: "Permission to use Bash has been denied because Claude Code is running in don't ask mode"
- Expected: `cd`, `timeout`, env-var prefixes, redirection, and `echo $?` after a command to work, or the CLAUDE.md to say they don't
- Fell short: the trial setup
- Where: .agents/trials/CLAUDE.md lists `bun`, `echo` and read commands only
- Workaround: plain `cd <dir> && bun ...` and `bun --cwd`-style calls worked; piping to `tail`/`grep` worked. I could not observe the exit code of `bun check.ts` and could not run `bun watcher.ts` as a real process (no `timeout`), so the `import.meta.main` entry is untested; `run()` itself is what check.ts exercises. No rack42u source read.
- Cost: minor

### `bun add` writes `#HEAD` into package.json

- Doing: `bun add --cwd <app> git+file:///…/rack42u#HEAD valibot`
- Happened: package.json got `"rack42u": "git+file:///home/zmmfly/prjs/rack42u#HEAD"`; the commit shows only in the output
- Expected: the resolved commit pinned
- Fell short: the documentation (getting-started says "Pin a tag or a commit" but not that Bun keeps the ref you typed)
- Where: getting-started.md#add-rack42u
- Workaround: edited package.json by hand with the commit Bun reported. No source read.
- Cost: minor

### No documented way to add and remove devices as a data file changes under `rack start`

- Doing: a URL added to watch.json must get a checker without restarting the others
- Happened: `rack start`/`rack dev` don't re-read a manifest when a file it reads changes (running.md says so), so `rack start` can't do it
- Expected: either a documented watch mode, or the spec's case being the documented pattern
- Fell short: the documentation (it was there, but under "Running a rack from code / A layout that follows data", easy to miss from the skill)
- Where: skill step 4/6 doesn't mention it; running.md#a-layout-that-follows-data does
- Workaround: wrote `watcher.ts` that runs `start()`, watches watch.json with `fs.watch`, and calls `reload(layout(...))`. The app therefore runs with `bun watcher.ts`, not `rack start`. No source read.
- Cost: minor

### A device's per-instance, in-memory state is module-level, which is easy to get wrong

- Doing: keeping a checker's last result and the store's reports across a hot swap
- Happened: `snapshot`/`restore` take `ctx`-less or `_ctx` args and the doc example uses module-level `let`; closures created in `powerOn` aren't reachable from `snapshot`/`restore`, so I first wrote a awkward hook-indirection before using module-level state
- Expected: a documented way to reach per-instance state from `snapshot`
- Fell short: the documentation
- Where: devices.md#a-device-file shows module-level state without saying why it is the pattern (one Worker per instance)
- Workaround: module-level variables. No source read.
- Cost: minor

### Injected faults are reachable only through `start()` options, and a hang test needs the default 10 s

- Doing: making a checker hang and crash from check.ts
- Happened: worked as documented (`faultInjection: true`, `rack.injectFault(name, "hang")`); the hang recovers in about 9.8 s with the default watchdog
- Expected: same; noting that the spec's "within 30 s" is met by the defaults
- Fell short: none (noted for completeness)
- Where: faults.md, testing.md#crashes-and-hangs
- Workaround: none needed
- Cost: minor

### Update record `cause` for a plug during `reload()` is `reload`, not `plug`

- Doing: checking that only the new checker was plugged, via `history()`
- Happened: record was `{ mode: "plug", cause: "reload" }`; I had read updates.md as `cause: "plug"`
- Expected: `cause: "plug"` for a plug
- Fell short: the documentation
- Where: updates.md#history says `cause` says what asked for the update (reload, swap, ..., plug, unplug); `mode` also says plug. When a reload does the plug, cause is `reload`; that is not spelled out
- Workaround: checked `mode`. No source read.
- Cost: minor

## Summary

- Works: a store device (keeps the last 100 reports and each URL's last result, serves `/events` and `/status` through the HTTP panel, keeps both through a hot swap); one `checker` device per URL, each its own named instance with own state, reporting to the store (success to failure, failure to success, other body; 10 s fetch timeout counts as failure); a crashed checker recovers (its last result comes back from the store); a hung checker recovers in about 10 s while others keep checking; a URL added to watch.json gets a plugged checker without touching the others (`watcher.ts` follows the file and calls `reload()`); `PORT` sets the panel port. `bun test` passes (5 tests, store and checker on the bench) and `bun check.ts` prints all good (it exits 0 by code; I could not observe the exit status in this setup).
- Doesn't work: `rack start` alone does not follow watch.json (use `bun run start`, which runs watcher.ts); removal of a URL unplugs its checker but the store keeps its last status; the `bun watcher.ts` entry point itself was not run as a process in this setup.
