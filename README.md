# rack42u

rack42u is a Bun framework for building an application out of hot-swappable **devices** mounted in a 42U-style **rack**. Each device runs in its own Worker, talks to other devices only through the rack's **backplane**, and can be replaced, reloaded, plugged in, or unplugged while the rack keeps running.

The framework provides the rack runtime and a few standard devices. What you mount in the rack, and whether the result is an API server, a worker process, or something else, is up to you.

> **Status: P3.** P3 adds byte streams in calls, listeners that devices open and that the rack hands over across swaps, and the HTTP panel as a standard device, with WebSocket, streaming bodies, and certificates that change without a restart. P2 added watchdogs for hung devices, stops that wait for a device's thread to end, and bounds on every backlog between devices. P1 added scanned racks, cold swaps and restarts, update safety, and `rack ctl` to P0, the first usable version. See [Not supported yet](#not-supported-yet) for what is still missing. rack42u has no formal release yet, so any version until the first one may break the API.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later. CI tests 1.4.4 on every system, and the latest Bun release on Linux. rack42u runs only on Bun, and ships as TypeScript source.
- Linux or Windows on x64, or macOS on Apple silicon: the systems that CI tests. [Windows](docs/guides/running.md#windows) lists what differs there.

## Try the example

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

The [guides](docs/README.md#guides) build a second small app, file by file, and the test suite extracts their files and runs them.

## Concepts

| Term | Meaning |
|---|---|
| Rack | One process. 42U by default; the size is configurable. |
| Slot | A position in the rack, numbered from 1 at the bottom. |
| Device | A module in one file that occupies one or more U. Each device runs in its own Worker. |
| Connector | A named, versioned contract of RPC methods and events, such as `kv/v1`. |
| Port | One connector on a device, addressed as `<device>.<port>`. |
| Backplane | The only channel between devices. Devices never import each other. |
| Link | A direct channel the backplane sets up from one device's need to another device's port. Calls and events between devices travel on links, Worker to Worker, without passing through the rack's main thread. |
| Patch | An explicit connection, needed when several devices provide the same connector. |
| Panel | A device that owns external connections, such as the standard [HTTP panel](docs/guides/http.md), and passes the work to other devices through the backplane. |
| Listener | An HTTP server, WebSocket included, that a device opens with `ctx.serve()`, and that the rack hands over when the device swaps. |
| Firmware | The hashed bundle a device file is built into; the hash is its version. |
| Swap | The one process behind replace, hot reload, plug, and unplug. |

The **gravity rule** holds the design together: a device may depend only on devices in lower slots. The rack powers devices on from the bottom up and off from the top down, so storage sits low and entry points sit high.

## Documentation

The [documentation](docs/README.md) has a guide for each part of rack42u, from connectors and devices to updates, faults, and the HTTP panel, and a reference of the API, the `rack` command, the error codes, and the reports.

## Not supported yet

- Devices run only in Workers, one each. Running a device in a child process is planned; no device ever runs on the rack's main thread.
- A management dashboard.
- Connecting several racks, and packaging a rack into one executable with `bun build --compile`.

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

Design decisions live in [`.agents/decisions/`](.agents/decisions); [`AGENTS.md`](AGENTS.md) explains how the project is run.

## License

[MIT](LICENSE)
