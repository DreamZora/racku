# The rack command

## Commands

| Command | Does |
|---|---|
| `rack start [manifest]` | Starts the rack in `manifest`, `rack.ts` in the current directory by default. |
| `rack dev [manifest]` | Starts the rack, then reloads the devices whose files change. |
| `rack plan [manifest]` | Prints the plan without starting the rack. For a scanned rack, `--write` writes the plan file, and `--check` checks it. |
| `rack ctl <operation>` | Operates the rack that runs from the current directory, as [Managing a running rack](../guides/managing.md) describes. |

## Exit codes

| Code | When |
|---|---|
| 0 | The rack shut down in order. |
| 1 | The rack failed to start, or a second stop came during the shutdown and ended it at once. |
| 2 | The command line is wrong, such as an unknown command or flag. |

## Flags of rack start and rack dev

| Flag | Meaning |
|---|---|
| `--log text`, `--log json` | `text`, the default, prints one line per entry, with warnings and errors on stderr. `json` prints each entry as one line of JSON on stdout, warnings and errors included: `{ time, level, device?, message, data? }`. A `bigint` in `data` is written as a string ending in `n`, and details that JSON can't hold, such as circular ones, as their `String()`. |
| `--stop-on-stdin-close` | Read standard input, drop what arrives, and shut down in order when it closes, as on `SIGTERM`. Signals and `rack ctl stop` work as before: whichever comes first starts the shutdown, and a second one ends it at once. |
