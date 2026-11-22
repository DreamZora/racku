# Decision: Fixes from the security review before 1.0.0

Status: accepted

## Background

- [The first formal release](261122_005312-first-formal-release.md#before-100) waits until every finding of high or medium severity from a security review is fixed, or stated as a limit with the user's agreement. On 2026-11-22 the user said "OK, Go ahead" to the review.
- Four agents reviewed rack42u on 2026-11-22, one boundary each, and confirmed what they found with probes on Linux and Bun 1.4.4:
  - the management endpoint and `rack ctl`;
  - the HTTP panel and listeners;
  - code loading, and the files that the rack writes;
  - net-tool and CI.
- The Agent checked each finding of high and medium severity against the code. It reproduced the two that a short probe settles:
  - `Bun.serve`'s routes sent `/api/%2e%2e/admin/users` and `/api/../admin/users` to an `/api/*` route, whose handler saw `/admin/users`;
  - `Bun.build` ran a macro in the builder's own process, and refused the build with `macros: false`.
- The threat model of the review: what the rack protects against, and what it trusts.
  - **Protected against:** clients of panels and listeners; other local users; web pages in the user's browser.
  - **Trusted:** device code, and whoever can write an app's files, an executable's base directory, or a hot-plug directory.
  - Whoever holds the management endpoint can run code as the rack's user, by design: a swap names a file, which the rack builds and runs.

### Findings

| Id | Finding | Severity | Who can use it |
|---|---|---|---|
| H1 | The panel matches a route on the raw path, while the device gets Bun's normalized URL, so `/api/%2e%2e/admin/users` reaches a device as `/admin/users` through an `/api/*` route | high | any client of a panel |
| H2 | A request body that streams has only an idle timer per read, so a client that sends a byte every few seconds holds a call slot of the route's device for as long as it likes; `queueLimit` of them make that device answer 503 | high | any client, with `queueLimit` connections, 10 000 by default |
| M1 | `rack ctl --token` puts the token on the command line, where every local user can read it | medium | any local user, while an operator runs it |
| M2 | An empty `RACK_CONTROL_TOKEN`, or `control.token`, turns authentication off, since `??` keeps `""` and a missing header compares as `""` | medium | any local user, after one misconfiguration |
| M3 | `Bun.build` runs the macros that a device file imports, inside the rack's process and without a bound, so a macro that never returns stalls every later build and the rack's stop | medium | device code, against the rule that the main thread runs no device |
| M4 | An executable reads a `.env` file where it starts, which can set `RACK_CONTROL_TOKEN` or the control directory | medium | whoever can write the directory where an executable starts |
| M5 | `httpHandler` keeps an entry for every upgrade that it accepted and that never completed | medium | any client that a device accepts |
| M6 | A client that stops reading holds its whole response in memory with no time bound, since Bun's idle timer doesn't fire while a write is pending | medium | any client |
| L1 | `rack ctl` sends the token of a stale control file to whatever listens on its port, after the rack ended; net-tool's window does the same after the sidecar ended | low | a local user who takes the port; a lasting token, such as from `RACK_CONTROL_TOKEN`, then works on the next rack |
| L2 | The control directory and file are trusted by path; an empty or relative `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, or `LOCALAPPDATA` puts the token file in the working directory | low | a local user whose directory a rack's environment names, such as under `su` without `-` |
| L3 | Checks of an earlier rack on the same base directory have no timeout | low | reliability |
| L4 | `.rack/` and its bundles get the umask's modes, and a bundle holds the files that a device imports, such as a JSON file of secrets | low | any local user who can reach the base directory |
| L5 | A `tsconfig.json` above the app directory changes what a bundle holds, such as through `paths` | low | a local user who can write an ancestor directory, such as `/tmp` |
| L6 | Firmware from earlier runs, from `rack plan`, and the extra files of a build are never deleted, against the limits table | low | reliability |
| L7 | The plan file and bundles are rewritten in place, so a crash can leave a torn plan file that the next start refuses | low | reliability |
| L8 | A message from a Worker that isn't an object throws on the main thread | low | device code, against fault containment |
| L9 | Text logs print control characters raw, so a newline in a message forges a line | low | whoever chooses text that a device logs, such as a client |
| L10 | The panel's error bodies carry a device's exception text, file paths, device names, and limits | low | any client that makes a device fail |
| L11 | `webSocket.maxConnections` doesn't count upgrades in flight, so a burst goes past it | low | any client |
| L12 | The `Host` check misses some spellings of loopback, such as `127.1`, and accepts malformed hosts | low | a web page, when the operator spells loopback so |
| L13 | An error in the panel's upgrade branch leaves the connection without its idle timer | low | any client of a device that puts client text into `protocol` |
| L14 | The listeners guide's WebSocket example checks no `Origin`, and the skill doesn't say to | low | a web page, against a device on loopback |
| L15 | In an executable, a package that it doesn't carry resolves from the `node_modules` of any parent directory, such as `C:\node_modules`, which any Windows user can create | low | another local user on Windows |
| L16 | net-tool's window keeps the messages of a socket with no byte bound | low | a peer of any socket that the user opened |
| I1 | `/v1/constructor` answers 200 with `RACK_NO_ROUTE`, not 404 | info | — |
| I2 | `docs/reference/cli.md` misstates when `rack ctl` sends `RACK_CONTROL_TOKEN` | info | — |
| I3 | Route params arrive percent-decoded, and the panel gives no client address | info | — |
| I4 | net-tool's installed rack accepts the development server's origin, and its README says that no other program on the machine can drive the tool, while programs of the same user can | info | — |
| I5 | Checkouts in CI keep the job's token, and the repository doesn't require actions pinned by commit | info | — |
| I6 | net-tool's installers have no signature or checksums | info | stated already, by the installers decision |
| U1 | A device that exhausts memory probably ends the rack's process, since Workers share it; not confirmed | unconfirmed | device code |

## Decision

Each fix below names the finding it answers. The threat model stays as it is.

### The HTTP panel and listeners

- **Routes see the device's path (H1).** A request reaches a route only when its path, as Bun normalizes it, matches the route's pattern. A request whose normalized path doesn't match, such as one whose dot segments lead out of the route, gets 404 with `RACK_NO_ROUTE`, as an unmatched path does.
- **Bodies arrive at a minimum rate (H2).**
  - A body without a declared length, such as a chunked one, is read whole when it ends within `streamThreshold`, under the same deadline as a body of declared length: `idleTimeout` for the whole body. Past `streamThreshold`, it streams, as now.
  - A body that streams must arrive at 1 KiB per second or more on average, counted from the start of the request, once its first `idleTimeout` has passed. One that falls below gets 408, and its call is cancelled.
  - The minimum is fixed, not an option. It lets a 1 MiB body take about 17 minutes, and makes holding a device's `queueLimit` slots cost a client about 10 MiB per second with the defaults.
- **Upgrades that don't complete (M5).** When an upgrade that a device accepted doesn't complete, the panel tells the device with `closed`, code 1006. This happens when Bun refuses it, or the client leaves before the answer. `httpHandler` drops an entry whose socket didn't open within `idleTimeout`, and keeps at most `maxConnections` entries.
- **Clients that stop reading (M6).** A response body of 1 MiB or more goes to the client in pieces that the panel watches. When the client takes no piece for `idleTimeout`, the panel ends the response and frees the body. Smaller bodies go whole, as [Panel responses no slower than the main-thread panel](261118_195832-faster-panel-responses.md) decides.
- **Error bodies (L10).** For `RACK_DEVICE_FAULT`, and for the errors that the rack makes, the panel's body says what happened in general terms, such as "the device failed" or "the device is overloaded", and the log keeps the details. An error code that a device defines keeps its message, which the device chose to send.
- **WebSocket connections (L11).** `webSocket.maxConnections` counts upgrades in flight with the open sockets. An upgrade takes its place before the panel calls the device, and gives it back when it fails.
- **Host (L12).** A listener decides whether it is on loopback from its address as Bun normalizes it, so `localhost`, `127.1`, and `0:0:0:0:0:0:0:1` count. It accepts a `Host` only of the forms `name`, `name:port`, `[ipv6]`, and `[ipv6]:port`.
- **The upgrade branch (L13).** An error while the panel upgrades a connection gets 502, and the connection gets its idle timer back.
- **Guidance (L14, I3).**
  - The listeners guide, and the skill, say to check `Origin` on WebSocket upgrades and on requests that change state, as the HTTP guide does, and their examples do.
  - The HTTP guide says that params arrive percent-decoded, and that a device checks a param before it puts it in a path.
  - It also says that the panel gives no client address, and that a panel open to the internet goes behind a reverse proxy, which can buffer bodies and limit clients by address.

### The management endpoint and rack ctl

- **No token on the command line (M1).** `rack ctl --url` takes the token from `RACK_CONTROL_TOKEN`, or from `--token-file <file>`, whose first line is the token. `--token` goes, from `rack ctl` and from an executable's `ctl`.
- **Tokens of 32 characters or more (M2).** A token that `RACK_CONTROL_TOKEN` or `control.token` gives must have at least 32 characters. A shorter one, an empty one included, fails the start with `RACK_MANIFEST`, and the error names where the token came from. A request authenticates only with `Authorization: Bearer <token>`, and a bare token gets 401.
- **Stale control files (L1).** `rack ctl` sends a control file's token only while the process that the file names runs. Otherwise it fails with "no running rack has the base directory", as when there is no file.
- **A private control directory (L2).**
  - The rack opens its endpoint only in a control directory that is a real directory, not a link, owned by its user, and with mode 0700 once the rack has set it. Otherwise the start fails with `RACK_MANIFEST`, and an error that says what is wrong.
  - The control file is written to a new file of mode 0600, then renamed into place.
  - An empty or relative `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, or `LOCALAPPDATA` counts as unset.
- **Checks of an earlier rack (L3).** A check of whether an earlier rack answers for the base directory gives up after 5 s. A socket or endpoint that accepted the check, but didn't answer within it, fails the start as one that answers does, with an error that says it didn't answer.
- **Operations (I1, I2).** The endpoint serves only the operations it lists, so any other name gets 404. `docs/reference/cli.md` says when `rack ctl` sends which token.

### Code loading and the files the rack writes

- **No macros (M3).** Builds run with macros turned off. A device file whose imports include a macro fails to build, with Bun's message, as other build errors do. A hot-plug file is then left out, and an outside file of an executable falls back to its packaged firmware. The limits table and the devices guide say so.
- **No `.env` in executables (M4).** `rack compile` turns off `autoloadDotenv`, as it turns off `autoloadBunfig`, so an executable reads no `.env` file. Its variables come from the program that starts it, such as a service manager, a shell, or a Tauri shell, as net-tool's does.
- **A private `.rack/` (L4).** The rack creates `.rack/` with mode 0700, and sets that mode on one that exists, so its bundles, plan, and records are only its user's. On Windows, `.rack/` keeps the access of the folder that holds it.
- **No `tsconfig.json` from above the app (L5).** A build reads the nearest `tsconfig.json` from the device file's directory upward, but not above the app directory; without one there, it reads none. The `package.json` that names a device's dependencies is found in the same way.
- **Firmware that nothing needs (L6).** The rack deletes the firmware that nothing needs at its start too, and counts every file that a build wrote as part of its firmware.
- **Whole files (L7).** The plan file is written to a new file, then renamed into place. A build doesn't write a bundle that exists with the same hash again.
- **Messages from Workers (L8).** The main thread drops a message from a Worker that isn't one of the Worker host's, with a warning that names the device, at most once per instance.
- **One line per entry (L9).** Text logs escape control characters in messages, as JSON does, so one entry stays one line. `--log json` doesn't change.
- **Packages of outside files (L15).** In an executable, a package that it doesn't carry may resolve only to a file inside the base directory. Otherwise the outside file fails to build, and its device falls back to its packaged firmware, which the log says.
- **Memory (U1).** The limits table states that a device that exhausts memory can end the rack's process, since Workers share it.

### net-tool and CI

- **The window (L1, L16).**
  - The shell tells the window when the rack ends after it started. The window then stops reconnecting, and says that the rack stopped.
  - The window keeps at most 8 MiB of messages per socket, and drops the oldest first.
- **Origins (I4).**
  - The installed app's rack accepts only the app's own origins. The development server's origin is added only when the debug shell starts the rack.
  - The README says that programs which run as the user can drive the tool, and that other users' programs and web pages can't.
- **CI (I5).** Every checkout sets `persist-credentials: false`. When the repository goes public, its settings require actions pinned by commit, as the workflows pin them now.
- **Installers (I6).** Signatures and checksums stay a limit of the installers, as their decision states. A later decision can add them.

### Failure modes

| Failure | Outcome |
|---|---|
| A request's normalized path leaves its route | 404 `RACK_NO_ROUTE` |
| A streamed body falls below 1 KiB per second | 408; the call is cancelled |
| A body of unknown length doesn't end within `streamThreshold` and `idleTimeout` | 408, as for a body of declared length |
| A client takes no piece of a body of 1 MiB or more for `idleTimeout` | The response ends, and the body is freed |
| A token shorter than 32 characters | The start fails with `RACK_MANIFEST` |
| A control directory that isn't private | The start fails with `RACK_MANIFEST` |
| An earlier rack that accepts but doesn't answer within 5 s | The start fails, saying that it didn't answer |
| A stale control file | `rack ctl` fails, saying that no rack runs, and sends nothing |
| A macro in a device file's imports | The build fails |
| An executable's outside file imports a package from outside its base directory | That file fails to build, and its device falls back |
| A malformed message from a Worker | Dropped, with a warning |

### Bounds

- Streamed request bodies: 1 KiB per second on average, after the first `idleTimeout`.
- Responses: pieces from 1 MiB on, each taken within `idleTimeout`.
- Tokens: 32 characters or more.
- Checks of an earlier rack: 5 s.
- `httpHandler`'s upgrades: `maxConnections` entries, each for at most `idleTimeout`.
- net-tool's window: 8 MiB of messages per socket.

### Observation

- **Logs:**
  - The panel logs a warning on the first request that it ends for a slow body or a client that stopped reading, then at most one per minute, with how many there were since.
  - The rack logs the warnings above for malformed Worker messages, and for packages outside an executable's base directory.
- **Startup failures:** failures of the start say what was wrong, and with which setting.

### Tests

Each fix has a test of its failure path, through the path that users take:

- requests with `%2e%2e` and `..` segments;
- a chunked body sent byte by byte, and a stream below the minimum rate;
- an upgrade that fails, and one whose client leaves;
- a client that stops reading a body of 1 MiB or more;
- error bodies;
- a burst of upgrades past `maxConnections`;
- `Host` spellings, and an error in the upgrade branch;
- `rack ctl` with `--token-file`, and without `--token`;
- empty and short tokens, and a bare token;
- a stale control file;
- a control directory that is a link, has another owner, or has loose modes, and empty and relative variables;
- an earlier rack that doesn't answer;
- `/v1/constructor`;
- a device file with a macro, under `rack start`, in a hot-plug directory, and in an executable;
- an executable started where a `.env` is;
- the modes of `.rack/`;
- a `tsconfig.json` above the app;
- firmware from an earlier run;
- a plan file written through a rename;
- a Worker that posts a string;
- a log message with a newline and an escape;
- an executable's outside file that imports a package from above its base directory;
- net-tool's window when its rack ends, and its bound on messages.

### Where this decision changes others

Each of these decisions stays, and this decision comes first where they differ:

- [The management endpoint](261117_005821-management-endpoint.md#the-command): `--token` gives way to `--token-file`, and tokens must have 32 characters or more.
- [Single executables](261120_011627-single-executables.md#running-an-executable): an executable reads no `.env` file, where the user approved on 2026-11-20 that it read one where it starts. A package that an outside file imports must resolve inside the base directory.
- [The HTTP panel](261118_071513-http-panel-device.md#requests) and [the stream threshold](261118_165318-stream-threshold.md#bodies-sent-whole): bodies of unknown length are read whole up to `streamThreshold`, streamed bodies have a minimum rate, and routes see the normalized path.
- [Faster panel responses](261118_195832-faster-panel-responses.md#responses-sent-whole): bodies of 1 MiB or more go to the client in watched pieces.

## Alternatives

- **H1: answer 400 to any path with dot segments.** It's simpler, but it refuses paths that normalize inside their route, which some clients send. Not chosen.
- **H2: an option for the minimum rate, or a total deadline for a body.** An option adds a setting that few apps need. A deadline cuts long uploads on slow links, which a rate allows. Not chosen.
- **H2 and M6: stating them as limits, with a reverse proxy in front of a public panel.** It leaves the panel open to cheap attacks wherever it faces clients directly. The guide still advises a proxy for the internet. Not chosen.
- **M1: keeping `--token`, with a warning in the docs.** The token would still reach the process list wherever someone follows the old docs. Not chosen.
- **M4: keeping `.env`, and stating that whoever can write the directory where an executable starts can open its endpoint.** It keeps the convenience that the user approved on 2026-11-20, at the cost of a takeover by whoever can write that directory. The user may prefer it; then only this item changes.
- **L1: challenge and response, so that the token never crosses the wire.** It would answer L1 entirely, and it suits the one authentication method that [the main thread runs no devices](261119_054850-main-thread-runs-no-devices.md) asks of later transports. It changes the protocol, so it belongs to the decision for those transports. Not chosen now.
- **U1: `resourceLimits` for Workers.** Bun 1.4.4 doesn't apply them: its types leave the option out, and on 2026-11-22 a Worker given a heap of 64 MB went on allocating. Not chosen.

## Impact

- **Changed:**
  - the HTTP panel, `httpHandler`, and listeners;
  - the management endpoint and `rack ctl`;
  - firmware builds, `rack compile`, and executables;
  - logs;
  - net-tool's shell, window, and rack;
  - the checkouts in CI.
- **Breaking:** `rack ctl --token` is gone; tokens shorter than 32 characters fail the start; executables read no `.env`; a device file with a macro fails to build. The commits mark them with `!`.
- **Documented:** the HTTP and listeners guides, the skill, the limits table, managing, the rack command, running, net-tool's README.
- **New tests:** as above.
- **Not changed:** the connectors, and the threat model.

## Implementation

- **The HTTP panel and listeners:**
  - `src/listeners.ts`: `routeCheck()`, which each route of a listener runs on the path of `request.url`, with its params; a request that doesn't fit goes to `fetch`. `normalHost()` and `isLoopback()` decide loopback from the normalized host name, which `allowedHosts` adds beside the one given, and `HOST_HEADER` holds the forms of `Host` that pass.
  - `src/std/http-panel.ts`:
    - `readUnknown()` reads a body of unknown length whole under the deadline of `readWhole()`, and `guard()` holds a streamed body to `MIN_RATE` with a `Meter` of the bytes and of the time that the panel waited for them;
    - `upgrades` holds the places of upgrades in flight, and `upgradeTo()` and `unopened()` handle an upgrade that doesn't complete;
    - `GENERAL` holds the messages for the rack's codes, and `warnSampled()` the sampled warnings, every `WARN_EVERY_MS`.
  - `src/std/http.ts`: `httpHandler` keeps an accepted upgrade for `UPGRADE_MS`, and at most `UPGRADES` of them.
  - Tests: in `test/http-panel.test.ts` and `test/listeners.test.ts`.
  - Documentation: the HTTP and listeners guides, the limits table, and the skill.
- **The management endpoint and rack ctl:**
  - `src/control.ts`: `tokenOf()` with `TOKEN_MIN`; `privateDirectory()`; `controlPaths()` takes only absolute variables; the control file is written to a new file of mode 0600 and renamed; `answers()` gives up after `CHECK_MS`; `serve()` takes only `Bearer <token>`, and only the operations that `OPERATIONS` holds as its own.
  - `src/commands.ts`: `sendOperation()` takes the token of `--url` from `tokenIn()`, for `--token-file`, or from `RACK_CONTROL_TOKEN`, and that of a control file only while `alive()` finds its process; `src/cli.ts` and `src/executable.ts` list `--token-file` in place of `--token`.
  - Tests: in `test/control.test.ts`.
  - Documentation: managing, and the rack command.

## Confirmation

- The user accepted this decision on 2026-11-22, with [the first formal release](261122_005312-first-formal-release.md) and [the trials of the newer features](261122_005441-trials-of-the-newer-features.md). The Agent's report had named its four breaking changes, and recommended that executables read no `.env`, against keeping it as the user approved on 2026-11-20. The user's words: "All are approved. If the name rack is not already taken, rename rack42u to rack before publishing to npm."
- The decision stands as drafted, so executables read no `.env` file.
