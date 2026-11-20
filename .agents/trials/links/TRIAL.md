# Trial: links

rack42u commit: 6c958991d3f135c41977795751f09e773615902d

## Problems

### Shell commands with redirection, mkdir, timeout, and compound commands are denied

- Doing: preparing the folder (`mkdir -p devices scratch`), and running `timeout 150 bun check.ts 2>&1 | tail`, and `bun check.ts; echo exit $?`
- Happened: "Permission to use Bash has been denied because Claude Code is running in don't ask mode."
- Expected: `mkdir` and `timeout` or `;`/pipes to be usable, or the instructions to list them as denied
- Fell short: the trial setup
- Where: CLAUDE.md of the trials folder lists only bun, bunx, curl, echo and read commands
- Workaround: the Write tool creates folders by itself; ran `bun check.ts` and `bun test` plain. Did not read rack42u's source.
- Cost: minor

### `bun add ...#HEAD` leaves `#HEAD` in package.json

- Doing: adding rack42u as the instructions say
- Happened: package.json got `"rack42u": "git+file:///...rack42u#HEAD"`; the commit shows only in bun's output
- Expected: the commit pinned automatically
- Fell short: the API (bun), documented in the trial CLAUDE.md
- Where: getting-started.md#add-rack42u talks about a tag; nothing on pinning a commit after `#HEAD`
- Workaround: edited package.json by hand to the reported commit
- Cost: minor

## Notes on how the app was checked

- The change while it runs: `check.ts` runs `bun run dev` (rack dev), rewrites `devices/codes.ts` (`LENGTH = 6` to `8`), waits for the log line `link-codes swapped`, then posts a new link (8 characters), and shows the old link still redirects and counts visits. It then restores the file, restarts with `bun run start`, and checks that the links and visits survived.
- The documentation (getting-started, http, testing, running) was enough for everything; no source was read. The bench test of the HTTP device calls the `http` port with the `http/v2` `handle` shape from guides/http.md.

## Summary

- Works: POST /links with validation, GET /<code> 302 with visit count, GET /links/<code>, SQLite under data/ surviving restarts, PORT from the environment, three devices (store, codes, web) plus sqlite and the HTTP panel, hot change of the code-making device (6 to 8 characters) while the rack runs. `bun test` (3 tests, each device on its own with stubs) and `bun check.ts` (exit 0) pass.
- Doesn't work: nothing known. `data/`, `.rack/` and `scratch/` are not covered by a .gitignore I could verify.
