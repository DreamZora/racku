# Trial: links

rack42u commit: 7dc1abaf4c1dc1efe6ccc749df8bc2ba153ee123

## Problems

### The skill's relative doc links do not resolve in the trial folder

- Doing: reading the skill, which links to `../../docs/...`
- Happened: from `.agents/trials/.claude/skills/rack42u/`, `../../docs` is not a folder; the docs exist only in `node_modules/rack42u/docs` after install
- Expected: links that work where the skill is read
- Fell short: the trial setup
- Where: skill `rack42u`, every link (it says docs are in `node_modules/rack42u/`, but links are relative to the package)
- Workaround: read `node_modules/rack42u/docs/` directly; no source read
- Cost: minor

### `bun init` leaves unrelated files

- Doing: creating the app's `package.json` with `bun init -y`
- Happened: also made `index.ts`, `README.md`, a `CLAUDE.md`, `tsconfig.json`; `package.json` got a `typecheck` script and a `typescript ^7` peer dependency
- Expected: the getting-started guide shows a hand-written `package.json`; I should have written it myself
- Fell short: documentation (getting started does not say whether to use `bun init`)
- Where: Getting started, "Create the app"
- Workaround: ignored the extra files (I cannot delete files; `index.ts` stays, unused)
- Cost: minor

### Docs do not say how to write a Bun-spawnable check against `rack start`

- Doing: writing `check.ts`, which starts the app on a free port, restarts it, and changes a device while it runs
- Happened: nothing failed, but I had to combine three pages: `rack start` flags (`--control-port`), `RACK_CONTROL_TOKEN`, and `rack ctl reload --url --token` from the CLI reference; the manifest reads `PORT` from `process.env` because panel `port` is config, not environment, and the docs never say that `rack.ts` may read env
- Expected: a short recipe for a port from the environment, and for changing a device in a running rack from a script
- Fell short: documentation
- Where: Running a rack / The rack command; no example of env-driven config in a manifest, nor of the `bin` path (`node_modules/.bin/rack`)
- Workaround: it worked as guessed; no source read
- Cost: minor

### Error data shape of `SQL_ERROR` as seen by a device is undocumented in code form

- Doing: mapping a unique constraint failure to a device error code
- Happened: docs say `data.code` holds the driver code; I wrote `(error as {data?:{code?:string}}).data?.code` since the port's thrown error type is not shown in docs (`isRackError` and `RackError` fields `code`, `data` are only implied)
- Expected: the type of errors thrown by `ctx.ports.*` stated in the Devices guide
- Fell short: documentation
- Where: Devices, "Data and errors": says what a device throws, not what a caller catches
- Workaround: guessed; the check (a real SQLite database, 51 unique codes, no collision actually exercised) does not prove the real constraint path, only the stub test does
- Cost: minor

## How the change while running was checked

`bun check.ts` starts `node_modules/.bin/rack start`, makes a link (6 characters), rewrites `devices/codes.ts` (`LENGTH = 6` to `8`), runs `rack ctl reload` against the running app, then makes a new link (8 characters) and visits both the old and the new. It restores the file afterwards.

## Summary

- Works: HTTP API, codes, SQLite storage in `data/` (path overridable with `LINKS_DB`), three separate devices, `PORT`; `bun test` (5 tests, each device on the bench with stubs); `bun check.ts` (all behaviors, a restart, the hot change of the codes device); `bun check` typechecks.
- Doesn't work: nothing known. Collision retry in `web` is tested only with stubs. The real `CODE_TAKEN` path through SQLite is not exercised.
