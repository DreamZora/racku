# The documentation of rack42u

This directory holds the documentation of rack42u, for builders of apps on it, people and agents alike. The [README](../README.md) introduces rack42u.

## Guides

Each guide covers one part of rack42u. Together they build one small app, a greeter, file by file: its connector in Connectors, its device in Devices, its manifest in Racks, its web device in The HTTP panel, the program that runs it in Running a rack, and its test in Testing a device. Read those six in that order; the others stand on their own.

- [Connectors](guides/connectors.md): contracts between devices, with RPC methods, events, schemas, and versions.
- [Devices](guides/devices.md): device files, hooks, the context, background work, errors, and needs from configuration.
- [Racks](guides/racks.md): manifests, scanned racks, shared instances and own copies, and the plan file.
- [The HTTP panel](guides/http.md): routes, requests, WebSocket, certificates, and the `http/v2` connector.
- [Running a rack](guides/running.md): the `rack` command, running a rack from another program, `rack dev`, running a rack from code, and Windows.
- [Testing a device](guides/testing.md): the bench and its stubs.
- [Binary data and streams](guides/data.md): moving and sharing buffers, and streaming bytes in calls.
- [Listeners](guides/listeners.md): HTTP and WebSocket servers that devices open, and that the rack hands over across swaps.
- [Updates](guides/updates.md): swaps, reloads, changed plans, fallback, rollback, and history.
- [Faults and overload](guides/faults.md): crashes, hangs and watchdogs, stuck threads, and bounded backlogs.
- [Managing a running rack](guides/managing.md): `rack ctl` and the management endpoint.
- [Storage devices](guides/storage.md): `memkv` and `sqlite`.

## Reference

- [API](reference/api.md): the options of `start()`, and the rack handle.
- [The rack command](reference/cli.md): its commands, exit codes, and flags.
- [Error codes](reference/errors.md): `RackError`, and the codes it carries.
- [Reports](reference/reports.md): what `metrics()` reports.
