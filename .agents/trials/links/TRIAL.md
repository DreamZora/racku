# Trial: links

racku commit: 76ec9c28a930ab6d0d6e6260980764cdaaddd616

## Problems

### `expect(bench.call(...)).rejects` hangs until the call times out

- Doing: testing that the store device turns a unique-constraint failure into `LINK_TAKEN`, with `await expect(store.call("links", "add", ...)).rejects.toMatchObject({ code: "LINK_TAKEN" })`.
- Happened: the test timed out; the received error was `RackError: store.links.add timed out after 30000 ms`, though the stub had thrown at once (logging in the stub showed it ran). `store.call(...).catch((e) => e)` returned `LINK_TAKEN` in 1 ms.
- Expected: `.rejects` to see the `LINK_TAKEN` rejection, as for any promise.
- Fell short: the documentation
- Where: `docs/guides/testing.md#members-of-a-bench`, `call(...)`: it doesn't say what `call` returns, or how to assert on a rejection.
- Workaround: `.catch((e) => e)` and then check `.code`. I did not read racku's source and did not find the cause; maybe the combination with `toMatchObject` on a RackError, not `call`.
- Cost: slowed

### Shipping an outside file needs its relative imports beside it (minor)

- Doing: replacing `devices/codes.ts` in `dist/` of the executable, which imports `../connectors.ts`.
- Happened: it works, but only because I also copied `connectors.ts` to `dist/`; the doc says "any other import must resolve from the file's place" and doesn't give an example with a shared connector file.
- Expected: a note that a replacement device needs the connector file next to it.
- Fell short: the documentation
- Where: `docs/guides/running.md#a-rack-in-one-executable`, Outside files
- Workaround: copy `connectors.ts` too (no source read).
- Cost: minor

### Trial setup: `cp` denied

- Doing: copying a test file into `scratch/`.
- Happened: Bash denied `cp`.
- Expected: that is per the folder's rules (only `bun`, `curl`, `echo`, and read commands).
- Fell short: trial setup (no real harm)
- Where: CLAUDE.md of the trials
- Workaround: edited the file in place. Also I could not delete the scratch probe test, so I emptied it: `bun test` otherwise ran it.
- Cost: minor

## How the change while the app runs was checked

`check.ts` does it twice. From sources: with `rack start` running, it rewrites `devices/codes.ts` (`LENGTH = 6` to `8`), runs `rack ctl reload`, posts links until a code has 8 characters, and checks the old link still redirects (file restored afterwards). With the executable `dist/links` running (base dir `dist/`): it writes `dist/connectors.ts` and `dist/devices/codes.ts` with 8 characters, runs `dist/links ctl reload --base-dir`-less from `dist/`, and checks the same.

## Summary

- Works: the whole API (create, 400s, 302 with visit count, info, 404s), SQLite persistence across a restart, PORT, separate devices (api, codes, store, sqlite, HTTP panel), hot change of the code maker under `rack start` with `ctl reload`, the executable `dist/links` with a code maker file placed beside it, `bun test` (5 tests), `bun check.ts` (all 30 checks, exit 0).
- Doesn't work: nothing known. The executable change applies at `ctl reload` (not `--watch`).
