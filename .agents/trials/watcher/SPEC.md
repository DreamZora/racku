# watcher: watches URLs, and reports what changes

Build this app on rack42u, in this folder. The folder's `CLAUDE.md`, one level up, says how to work here.

## What it does

It checks a list of URLs on a schedule, and reports when one of them changes or fails.

- The file `watch.json` lists what to watch: `{ "interval": 5, "urls": ["http://…", "…"] }`, with the interval in seconds.
- Every `interval` seconds, the app fetches each URL, and keeps its result: the status code, or the error, and a hash of the body.
- When a URL's result changes, from a success to a failure, from a failure to a success, or to another body, the app reports it: `{ "url", "at", "from", "to" }`.
- A fetch that takes longer than 10 s counts as a failure.
- `GET /events` answers the last 100 reports, newest first. `GET /status` answers each URL's last result, and when it was fetched.
- The HTTP port comes from the environment variable `PORT`, 3000 by default.

## How it is built

- Each URL has a checker of its own, a separate copy with its own state, so that a checker that misbehaves affects no other URL. The checkers send their reports to one device, which keeps them and serves them.
- A checker that hangs, such as one stuck in an endless loop, recovers by itself within 30 s, and the other checkers go on checking meanwhile.
- A checker that crashes recovers by itself.
- A URL added to `watch.json` while the app runs gets a checker, without a restart of the other checkers.

## Checks

- `bun test` tests each device on its own, with what it depends on stubbed.
- `bun check.ts` starts local HTTP servers, one that always answers the same, one whose body changes, one that fails, and one that never answers, and the app watching them. It shows:
  - the reports of the changes and the failures, and `/status`;
  - that a checker recovers from a hang and from a crash, which the check may cause on purpose, such as through what a test server answers;
  - that a URL added to `watch.json` while the app runs gets checked.

  It exits with code 0, or prints what failed and exits with code 1.

## Done

The app is done when `bun test` and `bun check.ts` pass. Say in `TRIAL.md` whatever you couldn't finish.
