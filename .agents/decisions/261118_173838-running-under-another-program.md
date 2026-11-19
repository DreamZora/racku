# Decision: Running a rack under another program

Status: accepted

## Background

- A program written in another language, such as the Rust shell of a Tauri app, runs a rack as a child process with `rack start`. On 2026-11-18 the user chose such an app, `examples/net-tool`, as the first project on rack42u, and left this part of its design to the Agent: "I don't quite understand this one; you decide."
- `rack start` shuts down in order on `SIGINT`, `SIGTERM`, `SIGBREAK`, and `rack ctl stop`, as [Windows as a supported platform](261118_015204-windows.md#changes-to-the-rack) and [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#the-protocol) decide. A parent program can't always use these:
  - Tauri's shell plugin ends its children with `kill()` when the app exits, which on Linux and macOS is `SIGKILL`, with no orderly shutdown.
  - On Windows, a program can't send Ctrl+C or Ctrl+Break to a child that has no console of its own.
  - A parent that crashes sends nothing, and the rack keeps running, holding its ports.
  - `rack ctl stop` works everywhere, but the parent would have to find the endpoint and, on Windows, read its token.
- `rack start` logs one line of text per entry, such as `[http-panel] info listening {"url":"http://127.0.0.1:41231/"}`. A parent that started a panel on port 0 has to parse that text to learn its URL.
- A program written in Bun can already run a rack inside itself with `start()`, with its own `logger`, and stop it with `stop()`. That needs nothing new.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since a rack stops in order when its parent ends, and also when its parent crashes, on every system;
  - maintainability, since the parent's side is one pipe and lines of JSON, in any language;
  - observability, since the parent gets every log entry as data;
  - extensibility, since any program can host a rack.

### Evidence

Measured on 2026-11-18 on the local machine, Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, with Bun 1.4.4 and probe scripts outside the repository:

- A Bun child whose standard input was a pipe saw it close, both through `Bun.stdin.stream()` and through `process.stdin`'s `end` event:
  - when the parent closed its end, about 1 ms later;
  - when the parent was killed with `SIGKILL`, at once, since the system closed the parent's end of the pipe.
- macOS and Windows were not measured; the tests of this decision run there in CI.

## Decision

### Stopping when standard input closes

- `rack start` and `rack dev` take `--stop-on-stdin-close`. With it, the rack reads its standard input, ignores what arrives, and shuts down in order when the input closes, as on `SIGTERM`: it exits with code 0 when the shutdown succeeds, and with code 1 when it fails.
- It is a flag because a rack started from a terminal, or with its input from `/dev/null`, would otherwise stop at once or never.
- So a parent stops the rack by closing the pipe, on every system, and the system closes the pipe when the parent ends for any reason, a crash or `SIGKILL` included.
- The signals and `rack ctl stop` work as before. Whichever comes first starts the shutdown, and a second one during it exits at once with code 1, as a second signal does.
- The shutdown is bounded by the rack's timeouts, as [Ending instances and stuck threads](261117_185131-ending-instances.md#ending-an-instance) decides. A parent that must not wait that long kills the rack after a grace period of its own, as it would without the flag.

### Logs as JSON

- `--log json` writes each log entry as one line of JSON on standard output, `{ time, level, device?, message, data? }`, the fields of a logger's entries. Warnings and errors go to standard output too, so a parent reads one stream in order.
- Values that JSON can't hold are written as the text format writes them: a `bigint` as a string ending in `n`, and details that can't be serialized as their `String()`.
- `--log text`, the default, keeps today's lines.
- So a parent learns what it needs from entries that exist already:
  - `listening`, with `data.url` and `device`, for each listener, the panel's on port 0 included;
  - `rack <name> started`, once every device is online;
  - `control listening`, with the endpoint's address.
- The command line's own messages, such as a usage error, stay text on standard error, before the rack starts.

### Exit codes

- They stay as they are, and the README lists them together: 0 after an orderly shutdown; 1 when the rack fails to start, its shutdown fails, or a second signal ends it; 2 for a usage error.

### Failure modes

| Failure | Outcome |
|---|---|
| The parent closes the pipe | the rack shuts down in order and exits with 0 |
| The parent crashes, or is killed | the system closes the pipe, and the rack shuts down in order |
| The shutdown hangs past its timeouts | the rack exits with 1 once they pass; a parent that waits longer kills it |
| A second stop during the shutdown | the rack exits at once with 1 |
| An entry whose details JSON can't hold | the line has them as text, as the text format does |

### Bounds

| What | Bound |
|---|---|
| Input read while waiting for the close | none kept: each chunk is dropped as it arrives |
| A shutdown | the rack's existing timeouts: each device's drain within `drainTimeout`, and each hook within `hookTimeout` |

### Observation

- The parent reads every log entry as JSON, the shutdown's entries included, and the exit code.

### Tests

- A child rack started with `--stop-on-stdin-close` shuts down in order and exits with 0 when its parent closes the pipe, and also when its parent is killed, on Linux, macOS, and Windows.
- Without the flag, closing standard input changes nothing.
- `--log json` writes one JSON object per line, `listening` with the panel's URL on port 0 among them, and a `bigint` in an entry's details as text.
- The exit codes of a failed start and a usage error.

## Alternatives

- **Stop when the parent's process id ends**, as language servers do with a `--clientProcessId`: it needs a timer that polls, and a process id can be reused.
- **Commands on standard input, such as `stop`**: more than a parent needs, and a parent that crashes sends nothing, so the close of the pipe must stop the rack anyway.
- **`rack ctl stop` from the parent**: it works on every system, but the parent must find the endpoint, and read the token on Windows. A crashed parent sends nothing.
- **A file or a line on standard output that reports readiness, apart from the log**: the `listening` and `started` entries already say it, and a second format would repeat them.
- **JSON logs as the default**: they read worse in a terminal, and today's lines are what the README shows.

## Impact

- `src/cli.ts` takes the two flags, for `start` and `dev`; `src/log.ts` gains the JSON format.
- The README's "Running a rack" section: the flags, the exit codes, and a note on hosting a rack from another program, with a grace period before a kill.
- `AGENTS.md`: unchanged, apart from the current state.
- Not breaking: both flags are new, and the defaults keep today's behavior.
- Follow-up work once this decision is accepted:
  - The flags, with tests in `test/cli.test.ts` that run on every system.
  - `examples/net-tool`, whose Tauri shell uses both, as its own decision describes.

## Confirmation

- The user accepted this decision on 2026-11-18, after reviewing it: "I've reviewed it and I agree. Commit it."
- The user had left this part of the tool's design to the Agent: "I don't quite understand this one; you decide."
