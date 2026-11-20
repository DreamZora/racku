# Trial: chat

rack42u commit: 6c958991d3f135c41977795751f09e773615902d

## Problems

### Compound shell commands denied

- Doing: creating files with a heredoc and `mkdir -p`; later a `for` loop running `bun check.ts` three times
- Happened: "Permission to use Bash has been denied because Claude Code is running in don't ask mode"
- Expected: the heredoc is by design (CLAUDE.md says to use editing tools); the loop was only to check for flakiness
- Fell short: the trial setup
- Where: n/a. The list of allowed commands does not say that `for`, `;` chains and `mkdir` are refused
- Workaround: used the Write tool (it creates folders) and ran each command on its own. No source read.
- Cost: minor

### The skill's install command does not match the trial's

- Doing: adding rack42u
- Happened: the skill says `bun add git+ssh://git@github.com/DreamZora/rack42u.git#<tag>`; this trial uses `git+file://<repo>#HEAD`. Bun saved `#HEAD` in package.json, which had to be edited to the commit by hand
- Expected: a way to have Bun pin the commit
- Fell short: documentation
- Where: getting-started.md "Add rack42u" says to pin, but gives no way to get the commit into package.json automatically
- Workaround: edited package.json by hand
- Cost: minor

### `start()` has no quiet option documented near the example

- Doing: silencing the rack's console log in check.ts
- Happened: I guessed `log: "silent"`, which TypeScript-wise needed `as any` and was ignored; the logs still printed
- Expected: an obvious option; found `logger` only by grepping reference/api.md
- Fell short: documentation
- Where: guides/running.md "Running a rack from code" shows `start(manifest, { baseDir })` and never mentions `logger`
- Workaround: `logger: () => {}`. No source read.
- Cost: minor

### No example of a swap that changes the file under `start()`

- Doing: the check must change the handling device while the app runs
- Happened: docs show `rack dev` file edits and `swap(name, source?)`, but nothing says whether `swap(name)` of an unchanged file does anything, or how to make a check change a device. I wrote a modified copy of the device into `scratch/` and swapped to it (its relative imports must still resolve)
- Expected: a recipe for tests of a hot swap
- Fell short: documentation
- Where: guides/updates.md and reference/api.md `swap()` row
- Workaround: copy with a changed line, `running.swap("chat", "./scratch/chat-next.ts")`, then `running.history("chat")[0]` to confirm. No source read.
- Cost: minor

### Module-level variable needed to reach the handler from snapshot

- Doing: handing the sockets to the new instance (`handler.list()` in snapshot, `handler.restore()` in restore)
- Happened: `snapshot` and `restore` get no access to what `powerOn` built, so the handler and the history's map have to live in module variables
- Expected: a documented place for per-instance state, such as the return value of `powerOn` or a `ctx` member
- Fell short: API / documentation
- Where: guides/devices.md "Hooks" and the greeter example, which also uses a module variable without saying why it is safe (one instance per Worker?)
- Workaround: module-level `let handler`. It worked in the swap. No source read.
- Cost: minor

## Summary

- Works: connections to `/chat?room=&user=` with validation (400 otherwise), recent messages (last 20, oldest first) on join, broadcast within a room sender included, `message too long` error to the sender only, `GET /rooms`, `PORT` from the environment, history in a device of its own, a hot swap of the handling device with clients staying connected and chatting. `bun test` (4 tests) and `bun check.ts` pass, and `bun check.ts` passed on each run.
- Doesn't work: nothing known. Not done: a run of `check.ts` many times for flakiness (loops denied); a message that arrives between a joiner's recent fetch and its readiness may be duplicated or reordered. Binary messages get the "message too long" error, which the spec does not define.
