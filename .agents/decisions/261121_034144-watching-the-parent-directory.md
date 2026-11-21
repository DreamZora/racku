# Decision: A watching rack also watches its base directory's parent, to notice the base directory's removal on macOS

Status: accepted

## Background

- [Executables that apply changed device files on command, or as they change with --watch](261120_221450-watching-outside-files.md#failure-modes) decides that when the base directory of a watching rack, `rack dev` or an executable with `--watch`, is removed, "Watching stops, the log errors `stopped watching <dir>: it was removed`, and the rack runs on". Its [bounds](261120_221450-watching-outside-files.md#bounds) give it one watch, the base directory's, recursive.
- The first run of `check.yml` on `feat/p4`, 44890705235 on 2026-11-21, passed the test of a removed base directory of `rack dev` on Linux and Windows, and failed it on macOS: the rack ran on, but never logged that watching stopped.
- Bun 1.4.4 watches with FSEvents on macOS. The callback that turns FSEvents' events into `fs.watch` events, `events_cb` in `src/runtime/node/fs_events.rs`, drops every event about the watched directory itself: "Ignore events with path equal to directory itself". The removal of the base directory is such an event. In CI, the removal of the base directory and of what it held reached the rack as no event at all, most likely folded by FSEvents into the one event about the directory.
- On Linux, inotify reports the watched directory's own removal, which Bun passes on without a file name; on Windows, the removal reaches the watch as well.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability: a watching rack learns that its base directory is gone on every system, and goes on running;
  - observability: the log says so on every system, as the earlier decision promises.

## Decision

### A second watch, of the parent

- A watching rack also watches the parent of its base directory, without recursion, from when the base directory's watch starts until it stops.
- An event of the parent's watch counts only when it names the base directory, or names nothing: then the rack checks the base directory at once, as a due reload does. A base directory that is gone, or no longer a directory, stops watching, with the log's error `stopped watching <dir>: it was removed`.
- So the removal, and a rename that moves the base directory away, reach the rack as an event about a directory entry of the parent, which FSEvents' callback passes on.
- A base directory without a parent, the root of a file system, gets no second watch.

### Failure modes

| Failure | Outcome |
|---|---|
| The parent can't be watched, such as one that the rack's user can't read | The log warns `cannot watch <parent> for the removal of <dir>: <reason>`, and the base directory's watch goes on. On macOS, a removed base directory may then go unnoticed, as before this decision. |
| The parent's watch fails later | It stops, without a log entry of its own; the base directory's watch goes on. |
| The parent is busy, such as the system's temporary directory | Each event about another entry costs the comparison of its name. |

### Bounds

| What | Bound |
|---|---|
| Watches of a watching rack | Two: the base directory's, recursive, and its parent's, not recursive |

### Observation

- The log errors `stopped watching <dir>: it was removed` on every system, and warns when the parent can't be watched.

### Tests

- The test of a removed base directory of `rack dev`, in `test/cli.test.ts`, on Linux, macOS, and Windows. Its timeout exceeds its wait, so that a failure prints the rack's output.
- `watchAndReload()` with a stub rack: a base directory removed, and one renamed away, stop watching with `it was removed`; and on Linux and macOS, a parent that the user can't read logs the warning, and the base directory's watch still reloads after a change.

### Dependencies

None.

## Alternatives

- **A limit on macOS, documented**: one watch, as decided before; on macOS, the rack would run on after its base directory is removed, without the log's error. The user chose the second watch.
- **Checking the base directory on a timer**: it would notice the removal on every system, with work at every tick and a delay up to its period, for what the parent's watch reports at once.
- **Waiting for an event of the base directory's own watch**: on macOS, none came in CI.

## Impact

- `src/dev.ts`: `watchAndReload()` watches the parent too.
- [Executables that apply changed device files on command, or as they change with --watch](261120_221450-watching-outside-files.md) stays as it is, apart from its bound of watches and the way the removal is noticed, which this decision replaces.
- Documentation: the watches in [Watching](../../docs/reference/limits.md#watching).
- Costs: one more watch per watching rack, which counts toward a system's limit of watches, such as Linux's `max_user_watches`.

## Implementation

- `watchParent()` in `src/dev.ts` watches the parent, and `watchAndReload()` checks the base directory at each of its events that names the base directory, or nothing, and closes it with the base directory's watch.
- Tests: in `test/watch.test.ts`, a base directory removed, one renamed away, and a parent that the user can't read, which Windows skips, since it has no such mode; in `test/cli.test.ts`, the test of `rack dev`'s removed base directory, with a timeout of 30 s, above its wait of 15 s.
- On Linux, a probe on 2026-11-21 saw the parent's watch report `rename` with the base directory's name for its removal and for its rename, and nothing for a change inside it.
- Documentation: the watches in [Watching](../../docs/reference/limits.md#watching).

## Confirmation

- The user chose this on 2026-11-21, between it and documenting a limit on macOS, after the Agent's report of the failure on macOS. The user's answer: "Watch the parent too (Recommended)", the option described as "Also watch the base folder's parent, without recursion, only for the base folder's own removal or rename. That is the event Bun does pass on, so it's precise on all three systems. Costs one extra watch per watching rack; the decision's bound goes from one watch to two."
