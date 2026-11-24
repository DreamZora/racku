# Decision: rack dashboard, a page in the browser that monitors and operates a running rack, and the feed of the rack's recent events

Status: accepted

## Background

- racku has no dashboard. The README's "Not supported yet" and `docs/design.md` list one, and [The first formal release](261122_005312-first-formal-release.md#the-version-and-what-it-promises) left it out of 1.0.0: it needs its own decision, and can come in a minor version. [Rack runtime architecture](261112_035942-rack-architecture.md#reliability-and-management) plans a management controller for status and remote operations.
- What a running rack reports, as [Reports](../../docs/reference/reports.md) gives it:
  - `status()`, `metrics()`, and `history()`, which `rack ctl` prints as JSON, one call at a time. Watching a rack over time means running `rack ctl` again and again.
  - The log, which goes to the `logger` of `start()`, so to the terminal or the log file of `rack start` and `rack dev`.
  - `subscribe()`, which delivers power, swap, fault, and log events to code in the rack's process only. Nothing keeps them, and the management endpoint has no operation for them: [its decision](261117_005821-management-endpoint.md#the-protocol) left "streaming rack events" for later.
- In `src/rack.ts`, `status()` and `history()` answer at once, and `metrics()` doesn't wait behind management operations, so all three answer during a swap. `metrics()` waits for each device's Worker up to `hookTimeout`, 30 s by default, and leaves out one that doesn't answer.
- Only processes of the rack's own user reach the management endpoint, as [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#transports) decides:
  - On Linux and macOS, it is a Unix socket, which browsers can't open.
  - On Windows, or with `--control-port`, it is loopback TCP with a token. That endpoint refuses requests that carry an `Origin` or a foreign `Host`, and anything but `POST`, so that no web page can drive it.
- Hard constraint 5 of `AGENTS.md`: the rack's main thread holds no external connections except the management endpoint.
- On 2026-11-24, the user asked: "Add a dashboard for racku to monitor rack status." To the Agent's questions, the user chose:
  - a web page served by a `rack dashboard` command, over a terminal view;
  - a dashboard that monitors and operates, over one that only monitors;
  - a feed of recent events, kept by the rack, over status, metrics, and history alone.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - observability first, since an operator sees what the rack is doing, what it did on its own, and why, as it happens;
  - reliability, since the dashboard runs outside the rack, can't take it down, and operates it only through the rack handle's queue;
  - maintainability, since the rack gains one method, and the dashboard is a client of the endpoint, as `rack ctl` is.

## Decision

### The rack keeps its recent events

- The rack keeps the events that `subscribe()` delivers, `power`, `swap`, `fault`, and `log`, as records in memory.
  - Log entries of level `debug` are left out, so that a device's debugging can't push the rest out. They still go to the logger and to subscribers.
- A record, the type `EventRecord`, is the event with two more fields:
  - `seq`: its number, which starts at 1 when the rack starts, and grows by one per record;
  - `time`: when the rack emitted the event, a millisecond timestamp. A log entry keeps its own `time`.
- The rack keeps the last 1,000 records: a new one beyond that drops the oldest. A restart of the rack starts empty, as `history()` does.
- A record holds at most 4,096 characters as JSON.
  - A longer one loses its `data`, and its error's `data`, and its messages are cut to 1,024 characters, ending in `…`. It then carries `cut: true`.
  - `data` is kept as `--log json` writes it: a `bigint` as a string ending in `n`, and details that JSON can't hold, such as circular ones, as their `String()`.
- `events(after?)` on the rack handle returns the records whose `seq` is greater than `after`, oldest first; without `after`, every record it keeps.
  - It answers at once, as `status()` and `history()` do, and still answers after `stop()`.
  - `after` is a whole number, 0 or more; another value fails with `RACK_INVALID_INPUT`.
  - A reader whose first record has a `seq` greater than `after + 1` knows that the records in between dropped out before it read them.
- The management endpoint serves it as the operation `events`, `{ "args": [after?] }`.
- `rack ctl events [--after <seq>]` prints the records as JSON, as `rack ctl history` prints its own, and so does an executable's `ctl events`.

### rack dashboard

```sh
rack dashboard [--dir <path>] [--port <port>]
rack dashboard --url <url> [--token-file <file>] [--port <port>]
```

- `rack dashboard` serves a dashboard of the rack whose base directory is the current directory, or `--dir`: a page in the browser that shows the rack, and runs operations on it.
- It runs as a process of its own, and reaches the rack through the rack's management endpoint, as `rack ctl` does:
  - by default, through the Unix socket, or else the control file of a running process;
  - with `--url`, through a TCP endpoint, with the token on the first line of `--token-file`, or else in `RACK_CONTROL_TOKEN`.
- It finds the endpoint again for each request. So it starts while no rack runs, and it follows a rack that stops and starts again for the same base directory.
- It listens on `127.0.0.1`, on a free port, or on `--port`. It prints one line with the page's URL:

  ```text
  dashboard of /srv/shop-api at http://127.0.0.1:43117/#token=<token>
  ```

- It also prints a line when the rack stops answering, and when it answers again, and one line per operation it forwards, with the outcome. It prints nothing else, and the token nowhere else.
- It shuts down on `SIGINT` and `SIGTERM`, and on Windows `SIGBREAK`, with exit code 0. It exits with 1 when it can't start, such as on a `--port` that is taken, or with a `--token-file` that it can't read, and with 2 for a wrong command line.
- An executable that `rack compile` made serves the same dashboard with `dashboard`, as it runs `ctl`, with `--base-dir` in place of `--dir`.
- The rack itself opens nothing new. Its main thread keeps the management endpoint as its only connection outside, as hard constraint 5 requires.

### Who can use the dashboard

- Whoever holds the page's URL can do through it what `rack ctl` does with the operations that [What the dashboard forwards](#what-the-dashboard-forwards) lists: read the rack, and reload, swap, restart, roll back, and stop it. So the URL is as secret as the rack's control token.
- The token:
  - has 256 random bits, and is new each time `rack dashboard` starts;
  - appears only in the URL that the dashboard prints, never on a command line, in a file, or in its other output;
  - is in the URL's fragment, which browsers don't send to the server, so no request line, server log, or `Referer` carries it.
- The page moves the token to its tab's session storage, and takes it out of the address bar.
- Every request of the page carries the token as `Authorization: Bearer <token>`, and no cookie carries it. So a request that a page of another site sends has no token.
- The dashboard compares the token in constant time, and answers 401, without detail, when it is missing or wrong.
- The dashboard also answers 403 to a request that only a page of another site would send:
  - a `Host` whose name isn't `127.0.0.1`, `localhost`, or `[::1]`, such as the name of a site that points its domain name at `127.0.0.1`. Any port passes, so that a port forward works;
  - an `Origin` other than the dashboard's own, `http://` followed by the `Host`;
  - a `Sec-Fetch-Site` other than `same-origin`.
- It sends no CORS headers, so no page of another site can read an answer.
- The page itself, its HTML, script, and style, holds no data, and loads without the token.
- What devices and clients wrote, such as log messages, device names, and errors, the page shows as text, never as markup.
  - A content security policy in the page's `<meta>` tag lets it load only the dashboard's own script and style, and send requests only to the dashboard.
- A page in another site's frame has no token, since only the tab that opened the URL holds it. The page also shows nothing when it isn't the top window.
- The dashboard listens on loopback only. A browser on another machine reaches it through a port forward, such as `ssh -L 8080:127.0.0.1:<port> <host>`. Management over the network stays with the management controller, as [the management endpoint](261117_005821-management-endpoint.md#transports) decides.

### What the dashboard forwards

- The page's requests are `POST /api/v1/<operation>` with `{ "args": [...] }`.
  - The dashboard forwards each to the rack's endpoint as `POST /v1/<operation>`.
  - It answers with the rack's answer, `{ "ok": true, "value": ... }` or `{ "ok": false, "error": { code, message, data? } }`.
- It forwards these operations, with the arguments that the endpoint takes:
  - to read: `status`, `metrics`, `history`, and `events`;
  - to operate: `reload`, `swap` with the device's name only, `restart`, `rollback`, and `stop`.
- Any other operation gets 404. `plug` and `unplug` stay with code, and a swap to another device file stays with `rack ctl`, so that a dashboard's URL can't make the rack run a file that it doesn't run already.
- It answers one operation of its own, `about`, with what it watches: the base directory, or the URL.
- Its other answers:
  - 400 for a malformed body, or arguments that the operation doesn't take;
  - 405 for any method other than `POST`;
  - 413 for a body over 64 KiB;
  - 502 when no rack answers, or the rack answers with an HTTP error, such as 401 to the token of `--url`, with a message for people;
  - 503 while 16 requests wait for the rack;
  - 504 when the rack doesn't answer in time.
- The dashboard keeps none of the rack's data between requests: the page decides when to ask.
- The dashboard's API serves its page, and isn't public API. Programs use the management endpoint, as `rack ctl` does.

### The page

- It asks for `status`, `history`, and `events` every second, and for `metrics` every 2 seconds.
  - Each kind of request waits for its answer before the next one: a tick that finds the last one still waiting is skipped.
  - `events` asks for the records after the last one the page holds.
- It shows:
  - **The rack:** what the dashboard watches, how many devices are in each state, the calls from outside per second, and how old the data is. While the rack doesn't answer, since when and why, with the last data dimmed.
  - **The rack's front:** its slots from the top down, each device a block as tall as the U it takes. Each block holds the device's name, its state as a word and an icon besides a color, and marks for a hot-plug device, a copy for an `own` need, and firmware packaged in an executable. Selecting a device shows its details.
  - **A device's details:**
    - everything `status()` reports for it, from its firmware and known-good firmware to its watchdogs, listeners, certificates, and stuck threads;
    - its counters, per member of its ports and needs: calls and errors per second, errors by code, and the mean duration;
    - its event loop's delay, and a chart of its calls per second over the last 2 minutes;
    - its updates in the history.
  - **Calls from outside:** per address and member, calls and errors per second, and the calls that reached no port.
  - **The history:** the update records, newest first.
  - **The events:** the records of the feed, newest first, which the operator can narrow to a level and a device, with a note of how many dropped out before the page read them.
- Rates come from the difference between two readings of the counters. A device's counters restart when its instance changes, which its `firmware` or `since` shows; that interval gives no rate.
- The page keeps at most 1,000 records of the feed, and 60 readings per device for its charts.
- It follows the system's light or dark appearance, and never shows a state by color alone.

### Operations from the page

- For the rack: **Reload**, which rebuilds the firmware and replaces the devices whose hash changed, and **Stop**.
- For a device:
  - **Swap**, a new build of its own file;
  - **Restart**, with or without its consumers;
  - **Roll back**, to its known-good firmware, or to firmware that its history lists.
- Each asks first, in a dialog that names the device and what the operation does. Stop's dialog names the base directory, and says that the rack shuts down, and that the dashboard can't start it again.
- The page runs one operation at a time, and shows its outcome: the devices it replaced, or its error with its code.
- The rack runs the operations in its queue, with those of `rack ctl` and of code, one at a time, in call order.

### Bounds

| Bound | Value | Kept by |
|---|---|---|
| Records of the feed | the last 1,000 | the rack |
| One record, as JSON | 4,096 characters; a longer one is cut | the rack |
| Requests that wait for the rack | 16; more get 503 | the dashboard |
| A request's body | 64 KiB; a larger one gets 413 | the dashboard |
| The wait for a read | 60 s, more than the default `hookTimeout` for which `metrics()` waits for a device; then 504 | the dashboard |
| The wait for an operation | 10 minutes; then 504 | the dashboard |
| Requests of a page | one at a time per kind; `status`, `history`, and `events` every second, `metrics` every 2 s | the page |
| What a page keeps | 1,000 records of the feed, and 60 readings per device | the page |

### What can go wrong

| Failure | Outcome |
|---|---|
| No rack runs for the base directory | The dashboard starts anyway. The page says that no running rack has the base directory, and shows the rack once one starts. |
| The rack stops or crashes while the page shows it | Requests get 502. The page says since when, dims the last data, and goes on asking. A rack that starts again for the same base directory appears, its feed from `seq` 1. |
| The rack refuses the token of `--url` | 502, naming the rack's 401. The page says that the rack refused the token. |
| A device doesn't answer `metrics()` | The rack leaves it out after `hookTimeout`. The page shows its counters as missing, while status and events go on every second. |
| The rack doesn't answer a read within 60 s | 504. The page keeps the last data, and shows its age. |
| An operation fails | The page shows its code and message, and the dashboard prints them. |
| An operation doesn't end within 10 minutes | 504. The page says that it may still run, and that the history will show its outcome. |
| 16 requests already wait for the rack | 503. The page asks again at its next tick. |
| A request without the token, or with one of an earlier start of the dashboard | 401. The page asks for the URL that `rack dashboard` printed. |
| A page of another site, or one reached through a domain name that points at `127.0.0.1` | 401 or 403. Nothing reaches the rack. |
| Records drop out of the feed before the page reads them | The page notes how many. |
| The port that `--port` names is taken | `rack dashboard` exits with code 1, naming the port. |
| A log message holds markup or control characters | The page shows it as text. |
| The page stays open for days | What it keeps stays within its bounds. |

### How the page is built

- The page is in `src/dashboard/`: an HTML file, TypeScript modules, and a stylesheet.
- `rack dashboard` serves it with Bun's HTML imports: Bun bundles the modules and the stylesheet when the dashboard starts, without its development tools. `rack compile` bundles them into the executable. So the page needs no build step, and no dependency.
- The page's code uses the DOM's types, which disagree with Bun's on racku's server code, so `bun run typecheck` checks it as a program of its own.
- The page and racku share the types of the reports, so a change to a report that the page doesn't follow fails the type check.
- What the page computes, such as rates, what it keeps, and the state of its connection, is in modules without the DOM, which tests run in Bun.

### Tests

- **The feed**, with racks in the test's process:
  - the records and their order, `seq` and `time`, and debug entries left out;
  - the bound of 1,000, a record cut at 4,096 characters, and `bigint` and circular data;
  - `events(after)` across dropped records, a wrong `after`, and `events()` after `stop()`;
  - the operation through the endpoint on both transports, and `rack ctl events`.
- **The dashboard**, spawned as `rack dashboard` against a running rack:
  - each forwarded operation, and the ones it refuses, such as a swap to another file;
  - a token that is missing, wrong, or without `Bearer`; the `Host`, `Origin`, and `Sec-Fetch-Site` checks; other methods; a body over 64 KiB; and the bound of 16 requests;
  - that it listens on loopback only, and a `--port` that is taken;
  - no rack at its start, a rack that stops and starts again, and `--url` with a wrong token;
  - waits past their bounds, with bounds that the test shortens, and a device that hangs;
  - an executable's `dashboard`.
- **The page's logic**, in Bun: rates, counters that restart, dropped records, and what the page keeps.
- **The page in a browser:**
  - A test drives headless Chrome or Chromium over the DevTools protocol, with Bun's WebSocket and no new dependency.
  - It opens the URL that `rack dashboard` printed, and sees the devices and their states. It sees a crash that `injectFault()` causes, in the device's state and in the events. It confirms a restart, which the history then lists. Without the URL's fragment, the page shows nothing of the rack.
  - It runs where it finds Chrome or Chromium: `CHROME`, the names on `PATH` that `render:images` looks for, or the places where Chrome installs on macOS and Windows.
  - CI's three systems have Chrome. There, with `CI` set, a missing browser fails the test; elsewhere, the test is skipped with a note.

### Documentation

- `docs/guides/managing.md`: a section on the dashboard, covering:
  - how to start it, open it, and reach it from another machine;
  - what it shows, and the operations it runs;
  - who can use it, and that its URL holds the token, so that a log that receives the dashboard's output, such as a service manager's, holds the token too.
- `docs/reference/cli.md`:
  - `rack dashboard`, with its flags and exit codes;
  - `rack ctl events` with `--after`;
  - an executable's `dashboard`.
- `docs/reference/api.md`: `events()` and `EventRecord`.
- `docs/reference/reports.md`: `events()`.
- `docs/reference/limits.md`: the bounds of the feed and of the dashboard.
- `README.md` and `docs/design.md` no longer list a dashboard as not supported.
- Tests that confirm what a section says name it with `@doc`, as [the documentation decision](261119_055008-documentation.md#tests-that-hold-the-documentation) requires.

## Evidence

Measured on 2026-11-24 with Bun 1.4.4 on Linux, with probes outside the repository, and Chromium driven by Playwright.

- **HTML imports.** The probe served an HTML file that named a TypeScript module and a stylesheet, with `import page from "./index.html"` in `Bun.serve({ routes: { "/": page }, development: false })`.
  - Bun bundled both: the HTML came back with one `<script type="module">` and one `<link rel="stylesheet">`, both naming hashed chunks, and no inline script.
  - An executable that `bun build --compile` made of the probe served the same page, with the probe's source directory moved away.
- **Headers.** The answers for an HTML import carry only Bun's headers, `content-type`, `etag`, and from source `cache-control`. No option of `Bun.serve` adds one, such as `Content-Security-Policy`.
- **A meta tag.** A `<meta http-equiv="Content-Security-Policy">` in the HTML came through the bundling unchanged.
  - Its policy was `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`.
  - Under it, Chromium ran the bundled script and applied the stylesheet. A `fetch` from the page to `POST /api/v1/status`, with an `Authorization` header, got 200. The console showed no errors or warnings.
- **What the page's requests carry.** That `POST` carried:
  - `Origin: http://127.0.0.1:<port>`;
  - `Sec-Fetch-Site: same-origin`;
  - the `Host` of the URL;
  - no `Cookie`.
- **Routes.** A route `"/api/v1/:op": { POST }` answered a `POST`. A `GET` to the same path fell through to the server's `fetch`, so the dashboard answers 405 there itself.
- **Types.**
  - `tsc` with the repository's settings and the `DOM` library, over `src`, reported errors in `src/listeners.ts`: there, the DOM's `BodyInit` and `ReadableStreamController` differ from Bun's.
  - Without `DOM`, a module that uses `document` fails.
- **Text imports, the alternative.** The probe also imported the HTML, the stylesheet, and the TypeScript source as text, with `with { type: "text" }`, and compiled the script with `Bun.Transpiler`.
  - It served them with a `Content-Security-Policy` header, from source and from an executable.
  - `tsc` rejects such an import of a TypeScript file, which has no default export (TS1192), and of a `.css` file (TS2307).

## Alternatives

- **A terminal view, `rack top`.** Nothing would listen, so nothing new would need securing, and it would work over SSH as it is. The user chose a page in the browser.
- **A dashboard that only monitors.** A leaked URL couldn't change the rack. The user chose one that operates as well.
- **Status, metrics, and history alone.** The rack wouldn't change, and a crash would show only as a device's crash count and last error. The user chose the feed.
- **The dashboard in the rack's process,** such as `rack start --dashboard`. It would need one process fewer. But the main thread would hold a listener for browsers beside the management endpoint, against hard constraint 5, and a fault of the dashboard would be a fault of the thread that supervises the devices.
- **Pages served by the management endpoint.** On Linux and macOS the endpoint is a Unix socket, which browsers can't open. On TCP it refuses requests with an `Origin`, so that no page can drive it; serving a page would undo that.
- **A dashboard device in `racku/std`,** which would serve the page with `ctx.serve`. But no device can read the rack's status or run its operations. The main thread would have to offer them over the backplane, and a device that can restart the others would break the containment of faults.
- **A cookie in place of the bearer token.** Links would open in new tabs without the fragment. But browsers send a cookie with requests that pages of other sites make, so each request would rest on the `Origin` and `Host` checks alone.
- **Text imports with `Bun.Transpiler`, in place of HTML imports.** The dashboard could send real headers, `frame-ancestors` among them. But the page would be one script without imports, and `tsc` doesn't type such imports of TypeScript and CSS. The policy in the meta tag, and the token in the tab's session storage, cover what the headers would.
- **Server-sent events or a WebSocket, in place of asking every second.** There would be fewer requests. But `EventSource` can't send the token as a header, and the endpoint has no stream to pass on. Asking every second bounds the load, and recovers from any failure at the next tick.
- **Playwright or Puppeteer for the browser test.** They would drive the browser with less code. But they are dependencies, which a few calls of the DevTools protocol over Bun's WebSocket don't need.
- **A fixed token for the dashboard, as `RACK_CONTROL_TOKEN` gives the endpoint.** A bookmark would survive a restart of the dashboard. But it would be one more secret to keep in a service's environment, while the dashboard is meant to run when someone looks. The user accepted the decision without it, as [Confirmation](#confirmation) records.

## Impact

- **Gains:** an operator watches a rack in the browser, sees faults and updates as they happen, and operates it, with no new connection into the rack.
- **Public API, in a minor version,** as [The version, and what it promises](261122_005312-first-formal-release.md#the-version-and-what-it-promises) allows:
  - `rack dashboard`, its flags and exit codes, and an executable's `dashboard`;
  - `events()` and `EventRecord`, the endpoint operation `events`, and `rack ctl events` with `--after`;
  - the bounds of the feed and of the dashboard in [Limits](../../docs/reference/limits.md), which a later minor version may relax but not tighten.
- **Costs:**
  - The rack's main thread writes each event it keeps as JSON, once, and keeps up to 1,000 records of at most 4,096 characters each, under 8 MiB.
  - The dashboard is a second process, while it runs.
  - Whoever holds a dashboard's URL can operate the rack. A service manager that runs the dashboard keeps its URL in the service's log.
  - The page brings a second program for the type check, a driver of the browser in the tests, and a test that needs Chrome.
- **Hard constraints:** none change. The rack's main thread opens no new connection, and every operation goes through the rack handle.
- **Files:**
  - New: `src/dashboard/`, which holds the dashboard's server and its page, with the page's `tsconfig.json`; `test/dashboard.test.ts`; and a driver of the browser in `test/fixtures/`.
  - Changed:
    - `src/rack.ts`, which keeps the feed;
    - `src/control.ts`, which serves `events`;
    - `src/commands.ts`, `src/cli.ts`, and `src/executable.ts`;
    - `package.json`'s `typecheck`, and `tsconfig.json`, which leaves the page to its own program;
    - `AGENTS.md`'s "Current state" and repository structure;
    - the documents that [Documentation](#documentation) lists.
- **CI:** the dashboard listens on TCP and handles signals on the three systems. So a manual run of `check.yml` on the work's branch comes before the merge, as `AGENTS.md` asks.
- **Release:** the work goes on its own branch, and comes as racku 1.1.0. The merge into `main` and the tag wait for the user's word.
- **Later:** the operations that the dashboard doesn't offer, such as plugging and unplugging devices, access from other machines, and a streamed feed each need a decision of their own.

## Implementation

- **The feed:**
  - `src/rack.ts` keeps it, each record as its JSON text, with the bounds `FEED_LIMIT`, `RECORD_MAX`, and `CUT_MESSAGE`. A record still too long after the cut, such as one whose messages are full of characters that JSON escapes, or whose device's name or swap's `to` runs to thousands of characters, has those texts cut further, by half each time, and a `to` that isn't a string is cut as its `String()`. A record that JSON can't write, or that its cuts leave too long, keeps only its `seq`, `time`, `type`, and device's name cut to `MINIMAL_NAME` characters.
  - The rack spends a `seq` only on a record that it keeps, and keeping one never throws, so that the records stay numbered without gaps, and every subscriber still gets the event.
  - `events()` is a method of `RackHandle`, and `src/control.ts` serves the operation `events`.
  - `src/log.ts` exports `bigints` and `detailText`, which write details for the log and the feed alike, and `oneLine`, which escapes control characters for the text log and for the dashboard's output.
  - `EventRecord`, and the other shapes of the reports, are in `src/reports.ts`, which `src/rack.ts` and the modules that held them re-export.
- **The command lines:**
  - `src/commands.ts` finds a rack's endpoint for `rack ctl` and the dashboard, in `rackTarget`, `findEndpoint`, and `postOperation`, and parses `rack ctl events --after` in `ctlArgs`. `rack dashboard` runs `runDashboard` of `src/dashboard/server.ts`. `src/cli.ts` and `src/executable.ts` call both.
  - `postOperation` sends operations with `proxy: false`. Bun 1.4.4's `fetch` sends a request for `127.0.0.1`, its `Authorization` header included, through the proxy that `HTTP_PROXY` names, unless `NO_PROXY` names the host, as a probe confirmed on 2026-11-24. Before, `rack ctl` sent a TCP endpoint's token to such a proxy.
  - With a signal, as the dashboard gives it, `postOperation` also sends `timeout: false`, so that the dashboard's bounds decide how long it waits, and not Bun's idle timeout of `fetch`, which `BUN_CONFIG_HTTP_IDLE_TIMEOUT` sets to 5 minutes. `rack ctl` sends no signal, so that idle timeout still ends an operation of its own after 5 to 7 minutes.
- **The server:** `src/dashboard/server.ts`, with `openDashboard` and the bounds `WAITING_LIMIT` and `BODY_LIMIT`, and `READ_TIMEOUT_MS` and `OPERATION_TIMEOUT_MS` from `src/commands.ts`, which `rack ctl` shares, as [After the review of rack dashboard](261124_100151-after-the-dashboard-review.md#rack-ctl-waits-within-bounds) decides.
  - It listens with `reusePort: false`. Bun 1.4.4 sets `SO_REUSEPORT` on a server with `development: false` unless told not to, a bug that [Watching a fourth Bun bug](261124_100308-watching-a-fourth-bun-bug.md) records, so a dashboard would otherwise share a `--port` with another dashboard, or with a device's listener, which `ctx.serve` binds with `reusePort`.
  - Whether the rack answers, for the lines that the dashboard prints, comes from its answers to `status` alone, as the page's connection does. A rack still running racku 1.0.0 answers 404 to `events`, and that is the page's note, not a line.
  - Rollback's options take only `to`, a string of at most 128 characters, and restart's only `cascade`, a boolean; other options get 400.
  - A read's connection gets an idle timeout past its bound, and an operation's gets none and closes after its answer, since Bun ended a pending request without a body at its idle timeout in a probe.
- **The page:** `src/dashboard/page/`: `index.html`, `main.ts`, and the views, with the DOM; and, without it, the modules that tests run in Bun, such as `api.ts`, `poller.ts`, `rates.ts`, `feed.ts`, `connection.ts`, and `token.ts`. What the decision leaves open:
  - Rolling back to the known-good firmware sends its hash as `to`, since `rollback()` without `to` goes to the firmware before the current one.
  - An answer of `metrics()` that comes more than `LATE_READING_MS`, 1 s, after its request gives no device a rate for its interval or the next one, since the rack reads each device's counters as its Worker answers, and waits for the slowest. The calls from outside keep their rates, since the rack reads them last.
  - The page gives up on a read after 70 s, and on an operation after 610 s, so that the dashboard's 504 comes first.
  - Its colors passed the palette validator of the dataviz skill, for light and dark.
- **A departure, which [After the review of rack dashboard](261124_100151-after-the-dashboard-review.md#the-page-reads-the-feed-from-the-record-before-the-newest) decides:** [The page](#the-page) says that `events` asks for the records after the last one the page holds. The page asks for the records after the one before it, so that the newest comes back. An empty answer, or another record under that `seq`, shows a rack that started again, even within a second, which the page then reads from `seq` 1, as [What can go wrong](#what-can-go-wrong) has a rack that starts again appear. Asking after the newest, the page couldn't tell such a rack from one without new records.
- **Tests:**
  - `test/events.test.ts`: the feed, its bounds and cuts, records that JSON can't write, and the operation on both transports; `test/control.test.ts`: `rack ctl events` against a rack.
  - `test/dashboard.test.ts`: `rack dashboard` against racks and stand-in endpoints, a `--port` that another listener holds, waits past Bun's idle timeout, and the lines from `status`; `test/cli.test.ts` and `test/executable.test.ts`: the command lines, and an executable's `ctl events --after` and `dashboard --port`.
  - `test/dashboard-page.test.ts`: the page's logic.
  - `test/dashboard-browser.test.ts`: the page in headless Chrome, which `test/fixtures/browser.ts` drives over the DevTools protocol: the devices, a crash, every operation with its dialog and Cancel, the page without the URL's fragment and in another page's frame, and a screen 320 px wide.
  - `test/reference.test.ts`: the bounds that Limits gives, against the code.

## Confirmation

- On 2026-11-24 the Agent asked the user whether they accept this decision, with two open questions: whether the feed keeps log entries of level `debug` as well, and whether an environment variable fixes the dashboard's token, so that its URL lasts across restarts. The user's answer: "accept, you could use workflow to implement it with multi agent to speed up." The decision is accepted as written: the feed leaves out `debug` entries, and the dashboard's token is new at each start.
