# Trial: watcher

rack42u commit: fe584eb1318282dcf4a19ab463ef08e71881ad0a

## Problems

### Adding devices to a running rack from the app has no documented recipe

- Doing: finding how a URL added to `watch.json` while the app runs gets a checker of its own, without restarting the others.
- Happened: the skill and the guides show `plug`/`unplug` in the handle table, and "Changed plans and edited manifests" says `reload(manifest)` moves a running rack to a new layout, but nothing says how an app built on `rack start` can do this by itself (a device cannot reach the handle). I concluded the app needs its own `main.ts` that calls `start()` and `reload(manifest)`, with stable slot numbers per URL, and a `size` large enough for many checkers. No guide shows that; the API table has one line on `reload(manifest?)`.
- Expected: a guide section on a rack whose set of devices changes while it runs (who calls `plug`/`reload`, how slot numbers and names stay stable, how many slots there are).
- Fell short: documentation
- Where: Racks / Running a rack: "Running a rack from code" shows only a static manifest; the 42U default and the `size` option appear only in the Concepts text and in a type row of the API table.
- Workaround: `main.ts` polls `watch.json`, builds a new placed manifest (`size: 200`, checker `n` in slot `n+1`, named `checker-<slot>`), and calls `running.reload(manifest)`. Unchanged checkers kept their firmware and were not replaced (check.ts confirms it). Did not read the source for this, but grepped it once for the `size` check (not needed in the end).
- Cost: slowed

### `status()` is async and `crashes` is a number, not stated where I looked

- Doing: reading `status()` in check.ts to prove a checker crashed.
- Happened: the API table lists `status()` without saying it returns a promise; Reports says `crashes` is "the crashes within the last 60 seconds", which could be a list. A probe (`scratch/probe.ts`) showed a promise of an array, with `crashes: 0`.
- Expected: return type spelled out (`Promise<SlotStatus[]>`, `crashes: number`).
- Fell short: documentation
- Where: API, "The rack handle"; Reports, `status()` table.
- Workaround: ran a probe and printed the JSON. No source read.
- Cost: minor

### Hang and crash need a cause from inside the device

- Doing: making check.ts cause a hang and a crash of a checker "through what a test server answers".
- Happened: nothing in the docs suggests how a test provokes either. A device that throws inside `setTimeout` crashes (watched: `checker-7 crashed: exited with code 1`), an endless `for(;;)` is bitten by the event-loop watchdog after 10 s (12.4 s measured to recover). The checker has a chaos hook behind `WATCHER_CHAOS` for it, which is test code inside a production device. Also: a checker that hangs after every reset would reach the crash limit (more than 3 within the window) and be `faulted`, so the test server hangs once only.
- Expected: a documented way to provoke a crash or a hang in a device on the bench or in a test rack (the spec also asks for it in a rack check).
- Fell short: documentation
- Where: Testing a device / Faults and overload: bench has `faults`, but no way to cause one.
- Workaround: env flag read in the device, since Workers copy `process.env` when they start.
- Cost: minor

### A denied command (trial setup)

- Doing: probing and listing files in one compound command, `cd ../../.. ; cat ../.gitignore`, and a heredoc written with shell redirection.
- Happened: "Permission to use Bash has been denied because Claude Code is running in don't ask mode."
- Expected: these are outside the allowed commands (CLAUDE.md says so); the message does not say which part is denied.
- Fell short: trial setup (the message does not name the rule)
- Where: the folder's CLAUDE.md lists what is allowed; the denial does not say which part of a compound command broke it.
- Workaround: Write tool for files, single commands for the rest.
- Cost: minor

## Summary

- Works: a `store` device (slot 1) that keeps the last 100 reports and each URL's last result, and serves `GET /events` (newest first) and `GET /status` on `PORT` (3000 default) with `ctx.serve`; a `checker` device, one copy per URL with its own slot, name, and state, that fetches every `interval` seconds with a 10 s timeout, hashes the body, and reports changes (`{ url, at, from, to }`) to the store; a checker that is reset asks the store for the last result, so it does not report a false change; hang recovery (12.4 s measured, others kept checking), crash recovery, and a URL added to `watch.json` gets a checker while the others keep their firmware; URLs removed from `watch.json` lose their checker. `bun test` (7 tests, with the store stubbed for the checker, and a bench for the store) and `bun check.ts` pass.
- Doesn't work: `rack start` runs the initial URLs from `rack.ts` but doesn't follow later edits of `watch.json`; use `bun main.ts`. The store's state lives in memory only, so a crash of the store loses reports. An interval change in `watch.json` replaces the checkers (new config). The chaos hook (`WATCHER_CHAOS`) is in the checker device for the check.
