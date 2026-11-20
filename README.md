# rack42u

rack42u is a Bun framework for programs that must keep running while their parts change. You build the program out of **devices**, modules of one file each, and mount them in a **rack**, one process. Each device runs in a Worker of its own, talks to the others only through the rack's **backplane**, and can be replaced, reloaded, plugged in, or unplugged while the rest keep serving. What you mount, and whether the result is an API server, the backend of a desktop app, or something else, is up to you.

## The problem

A long-running program, such as a service or the backend of a desktop app, has parts that must change, fail, and recover on their own: a new version of one part should go live without a restart, a crash or a hang in one part should leave the others serving, and someone should be able to see what each part is doing. One Bun process falls short of that:

- **Code doesn't swap cleanly in a running process.** Importing a module again runs only that file, while the files it imports keep their old versions, and the old code stays in memory.
- **A fault takes everything down.** One uncaught exception ends the process, with all its parts.
- **Nothing bounds or watches the work.** A part that falls behind piles up calls until memory runs out, and one that hangs blocks its thread without anyone noticing.

## How rack42u solves it

```text
rack (one Bun process)
├── main thread      wiring, swaps, supervision, and the management endpoint; runs no device
├── U4 http-panel    a Worker: listens on port 3000, and routes /notes to web.http
├── U3 web           a Worker: needs notes/v1, and provides http/v2
├── U2 notes         a Worker: needs sql/v1, and provides notes/v1
└── U1 sqlite        a Worker: provides sql/v1
                     calls and events travel on links, from Worker to Worker
```

- **Devices in Workers.** Each device runs in a Worker of its own, so a new version loads as fresh code, and a crash, a leak, or a blocked event loop stays in its device.
- **Connectors.** Devices depend on contracts, such as `notes/v1`, with schemas for every input, output, and event, never on each other's code. The rack wires each need to a provider below it, and checks the data that crosses.
- **Swaps.** A new version of a device starts beside the old one, takes over its calls in one step, and receives its state, while the old one finishes what it holds. If the new one fails, the old firmware keeps or takes back its slot.
- **Supervision.** The rack resets a device that crashes, catches one that hangs with a watchdog, bounds every queue between devices, and falls back from an update that fails. What it does on its own, it reports in `status()`, `metrics()`, `history()`, and the log.

[Concepts](docs/concepts.md) explains each part, and how they work together.

## Why it is built this way

rack42u serves four goals, in this order when they conflict: **reliability**, so the rack keeps serving what it can; **maintainability**, so each part can be understood, changed, and tested on its own; **observability**, so an operator can see what the rack does and why; and **extensibility**, so builders add capabilities as devices and connectors, without changing the core. The main choices follow from them:

- one Worker per device, since only a fresh Worker gives a device fresh code, and only ending one frees everything a device opened;
- the backplane as the only channel between devices, so that any device can be replaced alone;
- links from Worker to Worker, so that calls don't wait for the main thread, which stays free to supervise;
- a content hash as each device's version, so that a rebuild replaces only what changed, and an update has known-good firmware to fall back to;
- fixed bounds and timeouts on every wait and queue, so that overload and hangs fail fast, with codes, instead of piling up.

[Design](docs/design.md) gives the reasons in full, what each choice costs, and the limits that remain.

## Quick start

The repository contains an example app, [`examples/shop-api`](examples/shop-api): a SQLite database at the bottom of the rack, an in-memory cache above it, an orders API above that, and on top the HTTP panel, which passes requests for `/api/*` to the orders API.

```sh
bun install
bun src/cli.ts start examples/shop-api/rack.ts   # PORT=4000 to change the port
```

```sh
curl -X POST localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"item":"book","quantity":2,"price":12.5}'
# {"id":1,"item":"book","quantity":2,"price":12.5}

curl localhost:3000/api/orders/1     # served from the cache: "cached":true
curl localhost:3000/api/orders       # {"currency":"USD","orders":[...]}
curl localhost:3000/api/stats        # {"served":4,"firmware":"..."}
```

Press Ctrl-C to stop: the rack powers devices off from the top down.

To see hot reload, start it with `dev` instead of `start`, then edit `examples/shop-api/devices/orders.ts`. The rack rebuilds every device, swaps only `orders`, and `/api/stats` keeps counting where it was, under a new firmware hash. The database and the cache are not touched.

```sh
bun src/cli.ts dev examples/shop-api/rack.ts
```

In an app that depends on `rack42u`, the package's `rack` command runs the same CLI: `rack start` and `rack dev`.

A second example, [`examples/net-tool`](examples/net-tool), is a desktop app: a TCP and UDP tool whose window, on Tauri 2 and Quasar, talks to a rack that holds the sockets. Its Tauri shell runs the rack as [another program](docs/guides/running.md#running-a-rack-from-another-program) would, and its devices are tested on the [bench](docs/guides/testing.md). Its README lists what it needs, such as Rust, and how to run it.

To build an app of your own, outside this repository, follow [Getting started](docs/getting-started.md): it adds rack42u to a new app through git, writes two devices and a rack, runs them, tests a device, and changes one while the rack runs.

## Status

What works, on Linux, macOS, and Windows:

- devices that call each other, emit events, and stream bytes, with schemas on every port;
- hot swaps, cold swaps, restarts, reloads under `rack dev`, fallback from updates that fail, rollback, and a history of updates;
- racks placed by hand, and racks scanned from directories of device files, with a plan file to review;
- crash resets, watchdogs, bounded backlogs, and the handling of threads stuck in native code;
- listeners that devices open, and the standard HTTP panel, with WebSocket, files sent from disk with their length, and certificates that change without a restart;
- the standard `memkv` and `sqlite` devices, the `rack` command, a test bench for one device, crashes and hangs that tests inject, counters, and logs that other programs can read;
- a rack packaged into one executable with `rack compile`, whose devices a file beside it can replace, with the packaged one to fall back to.

rack42u has no formal release yet: any version until the first one may break the API. An app depends on rack42u through git, at a tag or a commit of its repository, as [Getting started](docs/getting-started.md#add-rack42u) shows.

### Not supported yet

- Devices run only in Workers, one each. Running a device in a child process is planned; no device ever runs on the rack's main thread.
- A management dashboard.
- Connecting several racks.

## Documentation

- [Getting started](docs/getting-started.md): an app of your own, from adding rack42u to changing a device while the rack runs.
- [Concepts](docs/concepts.md) and [Design](docs/design.md): how a rack works, and why it is built this way.
- [The guides](docs/README.md#guides): one for each part of rack42u, from connectors and devices to updates, faults, and the HTTP panel. They build a small app, a greeter, file by file, and the test suite extracts their files and runs them.
- [The reference](docs/README.md#reference): the API, the `rack` command, the error codes, the reports, and the limits.
- [Working with an agent](docs/getting-started.md#working-with-an-agent): a skill for coding agents, such as Claude Code, which an app copies from the package, so that the agent reads the documentation of the version the app installed.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later. CI tests 1.4.4 on every system, and the latest Bun release on Linux. rack42u runs only on Bun, and ships as TypeScript source.
- Linux or Windows on x64, or macOS on Apple silicon: the systems that CI tests. [Windows](docs/guides/running.md#windows) lists what differs there.

## Development

| Purpose | Command |
|---|---|
| Run all tests | `bun test` |
| Type check | `bun run typecheck` |
| Lint and format check | `bun run lint` |
| Check decision records | `bun run check:decisions` |
| Check the documentation and its links | `bun run check:docs` |
| All of the above | `bun run check` |

CI runs for every push to `main`, and on request: `bun run check` on Linux, `bun test` on macOS and Windows, and `bun test` on the latest Bun release on Linux. A failure of any of the four jobs fails the run. To check a branch before merging it, start the workflow by hand with "Run workflow" on the Actions tab, or with `gh workflow run check.yml --ref <branch>`.

Design decisions live in [`.agents/decisions/`](.agents/decisions); [`AGENTS.md`](AGENTS.md) explains how the project is run. Problems go in GitHub issues, through the forms for bugs, documentation, features, and trial apps. [`.agents/trials/`](.agents/trials) holds the trial apps that agents build from the skill and the documentation alone; its README says how to run a round.

## License

[MIT](LICENSE)
