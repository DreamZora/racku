# Decision: After the review of rack dashboard: the page reads the feed from the record before the newest, rack ctl waits within bounds, rollback and restart check their options, and ListenerStatus types a listener's status

Status: accepted

## Background

- An independent review of the branch that implements [rack dashboard](261124_055114-rack-dashboard.md) found defects of the branch, which the branch fixes. It also found a departure of the page from that decision, and three problems that racku 1.0.0 already has:
  - The page asks the feed for the records after the one before the newest it holds, where [The page](261124_055114-rack-dashboard.md#the-page) says "after the last one the page holds".
  - `rack ctl` waits for an operation without a bound of its own, so Bun's idle timeout of `fetch`, 5 minutes by default, ends it after 5 to 7 minutes, with "cannot reach the rack: The operation timed out.", while the operation may still run.
  - `rollback()` checks neither the type nor the length of `to`, and `restart()` doesn't check the type of `cascade`. A `to` of 60 000 characters, or a number, went into the history, the device's `error`, the log, and the event that subscribers get; a `cascade` of `"false"` cascades.
  - The exported type `ListenerState`, which [API](../../docs/reference/api.md) describes as a listener "as `status()` reports it", has `index` and `listening`, which `status()` doesn't report. The entries of `SlotStatus.listeners` are of the type `ListenerStatus`, which racku doesn't export.
- On 2026-11-24 the Agent reported them, and asked whether to keep the departure. The user's answers: "2. Make your decision, choose best one." and "5. Fix old issues, join watching list if truely bug".
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since every wait gets a bound and an outcome, and the rack checks what it is given at its boundary;
  - observability, since the page shows a rack that started again, and a type says what the rack reports.

## Decision

### The page reads the feed from the record before the newest

- The page asks `events` for the records after the one before the newest it holds, so that the newest comes back with the new ones.
- An empty answer, or another record under that `seq`, shows a rack that started again, even within the second between two requests. The page then reads the new rack's feed from `seq` 1, as [What can go wrong](261124_055114-rack-dashboard.md#what-can-go-wrong) has such a rack appear.
- Each answer carries one record that the page holds already, of at most 4 096 characters.

### rack ctl waits within bounds

- `rack ctl`, and an executable's `ctl`, wait for the rack's answer within the dashboard's bounds: 60 s for `status`, `metrics`, `history`, and `events`, and 10 minutes for the operations that change the rack, `reload`, `swap`, `restart`, `rollback`, and `stop`.
- Past its bound, it exits with code 1, saying that the rack didn't answer within it; for an operation, also that the operation may still run, and that `rack ctl history` shows its outcome.
- No other timeout ends the wait, such as Bun's idle timeout of `fetch`.
- [Limits](../../docs/reference/limits.md) gives both bounds.

### rollback() and restart() check their options

- `rollback(name, { to })` takes a `to` that is a string of at most 128 characters, and `restart(name, { cascade })` a `cascade` that is `true` or `false`. Another value of either fails with `RACK_INVALID_INPUT` before the rack does anything: no history record, no event, and no change of the device's `error`.
- A `to` of the right kind that names no firmware the rack keeps fails as before, with `RACK_SWAP_REJECTED`.
- The management endpoint, `rack ctl`, and the dashboard pass the options on, so the same checks answer them.

### ListenerStatus is the type of a listener's status

- racku exports `ListenerStatus`, the type of each entry of `SlotStatus.listeners`: its `url`, `certificates`, `requests`, and `webSockets`.
- `ListenerState` stays as it is, marked `@deprecated`, since it adds `index` and `listening`, which `status()` doesn't report. It goes in the next major version, as [The version, and what it promises](261122_005312-first-formal-release.md#the-version-and-what-it-promises) requires.

### Where this decision changes others

- [rack dashboard](261124_055114-rack-dashboard.md#the-page): its bullet that `events` asks for the records after the last one the page holds gives way to [The page reads the feed from the record before the newest](#the-page-reads-the-feed-from-the-record-before-the-newest). That decision stays as it is, with a note in its Implementation.
- [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#the-command): `rack ctl` gains bounds on its waits. That decision stays as it is.

## Alternatives

- **Ask after the newest record, as the dashboard's decision says.** Each answer would carry one record fewer. But a rack that started again within a second answers nothing until its feed passes the page's number, and then only its records after that number: the page would mix two racks' feeds, and miss the new one's first records.
- **Have the rack report something that changes at each start, such as a number in `status()`.** The page would tell a new rack apart without the extra record. But that changes the shape of a report, while the feed already gives the answer.
- **No bound for rack ctl.** An operation would wait as long as the rack takes. But every wait needs a bound, and a rack that never answers would hold `rack ctl` for good.
- **Bounds of rack ctl's own, or flags to set them.** The options would grow, while the dashboard's bounds already fit: 60 s is more than the default `hookTimeout`, and 10 minutes more than any of the rack's own timeouts.
- **Change `ListenerState` to the shape that `status()` reports.** There would be one type fewer. But removing its fields breaks code that reads them, which only a major version may do.
- **Check rollback's `to` against the form of a firmware hash.** It would be stricter, but the form belongs to the firmware, outside the public API. A length bounds what the rack records, and a hash that the rack doesn't keep fails as before.

## Impact

- **Public API, in the minor version 1.1.0:** the export `ListenerStatus`; `ListenerState` deprecated; `RACK_INVALID_INPUT` for options of the wrong kind; the bounds of `rack ctl` in Limits.
- **Behavior:**
  - `rack ctl` no longer ends an operation after 5 to 7 minutes: a long reload gets up to 10 minutes.
  - Code that gave `rollback()` a `to` that isn't a string of at most 128 characters, or `restart()` a `cascade` that isn't a boolean, now gets `RACK_INVALID_INPUT`, in place of `RACK_SWAP_REJECTED` or a cascade.
- **Files:** `src/commands.ts`, `src/rack.ts`, `src/reports.ts`, `src/instance.ts`, `src/index.ts`, and `src/dashboard/server.ts`; their tests; and `docs/reference/api.md`, `cli.md`, `errors.md`, and `limits.md`.

## Implementation

- **The page:** `src/dashboard/page/feed.ts` asks `events` for the records after `newest - 1`, as the branch of the dashboard already did.
- **rack ctl:** `sendOperation` in `src/commands.ts` waits within `boundOf(op)`: `READ_TIMEOUT_MS` for the operations of `READS`, and `OPERATION_TIMEOUT_MS` for the others, through `postOperation` with an `AbortSignal.timeout`, so that `timeout: false` turns Bun's idle timeout off. `unanswered` writes what it says past a bound, and the dashboard's 504 uses it too. `test/cli.test.ts` holds it, with `BUN_CONFIG_HTTP_IDLE_TIMEOUT` set to 1 for a stand-in endpoint that answers after 10 s.
- **The options:** `wrongOptions` in `src/rack.ts`, with `TO_MAX`, checks them in the rack handle's `restart` and `rollback` before their operation joins the queue. `test/safety.test.ts` holds it.
- **The types:** `src/reports.ts` declares the deprecated `ListenerState` as a `ListenerStatus` with `index` and `listening`, which `src/index.ts` exports with `ListenerStatus`. The main thread's own type of a listener, in `src/instance.ts`, is `InstanceListener`. `test/listeners.test.ts` types what `status()` reports of a listener as `ListenerStatus[]`.
- **The documents:** `docs/reference/api.md` lists `ListenerStatus`, and `ListenerState` as deprecated; `errors.md` names the options among the arguments that fail with `RACK_INVALID_INPUT`; `limits.md` gives `rack ctl`'s bounds, and `cli.md` names them.

## Confirmation

- On 2026-11-24 the Agent reported the departure and the three problems, and asked how to go on. The user's answers: "2. Make your decision, choose best one." for the departure, and "5. Fix old issues, join watching list if truely bug" for the problems. The user authorized the Agent to decide them, so this decision is accepted on the Agent's choice, with those answers as the authorization. Each choice had a clear tradeoff, as Alternatives shows, so none went to the review model first.
