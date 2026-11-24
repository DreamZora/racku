# Decision: Watching a fourth Bun bug, by which development: false lets another server share a port

Status: accepted

## Background

- The review of [rack dashboard](261124_055114-rack-dashboard.md) found that `rack dashboard --port <port>` didn't fail on a port that another `rack dashboard`, or a device's listener, held: it listened beside it, and the system split the requests between the two. The dashboard passes `development: false` to `Bun.serve`, so that Bun serves its page without its development tools, and Bun 1.4.4 then sets `SO_REUSEPORT` on the socket.
- Bun documents `reusePort` as "Whether the `SO_REUSEPORT` flag should be set", with "@default false", and its documentation of `development` says nothing about ports.
- On 2026-11-24 the user asked that it join the Bun bugs under watch if it is truly a bug: "join watching list if truely bug". [After the review of rack dashboard](261124_100151-after-the-dashboard-review.md) records the rest of that answer.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since a server that silently shares its port loses part of its requests to another, and a port that is taken must fail the start.

### What Bun has on 2026-11-24

- No issue of Bun's names it. A search of its issues for `reusePort` and `development`, and for `SO_REUSEPORT`, found none about it.
- `src/runtime/server/ServerConfig.rs` of `bun-v1.4.4`, line 679, sets `args.reuse_port = args.development == DevelopmentOption::Production;` whenever the options name `development`, before it reads `reusePort`. Bun's `main` of that day has the same line. Bun 1.1.0's `src/bun.js/api/server.zig` already had it, as `args.reuse_port = !args.development;`.
- `NODE_ENV=production` also turns development off, but at a place that doesn't touch `reuse_port`, so a server without the option `development` keeps its port to itself.

### The bug, as racku reproduces it

A record in the sections of Bun's bug template, like those of [the other three](261122_215551-watching-a-third-bun-bug.md), though not for filing.

**Title:** `Bun.serve({ development: false })` sets `SO_REUSEPORT`, so a second server on the same port listens instead of failing

#### What version of Bun is running?

1.4.4 (38afee6c8)

#### What platform is your computer?

Linux 7.0.0-43-generic x86_64, Ubuntu 26.04.1 LTS

#### What steps can reproduce the bug?

`repro.ts`:

```ts
// Two servers on one port: the second should fail, as the port is taken.
for (const options of [{}, { development: true }, { development: false }]) {
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("first"), ...options });
  let outcome: string;
  try {
    const second = Bun.serve({
      hostname: "127.0.0.1",
      port: first.port,
      fetch: () => new Response("second"),
      ...options,
    });
    const answers = new Set<string>();
    for (let i = 0; i < 20; i++) {
      answers.add(await (await fetch(`http://127.0.0.1:${first.port}/`, { headers: { connection: "close" } })).text());
    }
    outcome = `the second server listens too; answers came from ${[...answers].sort().join(" and ")}`;
    second.stop(true);
  } catch (error) {
    outcome = `refused: ${(error as Error).message}`;
  }
  first.stop(true);
  console.log(`${JSON.stringify(options)}: ${outcome}`);
}
```

Run `bun repro.ts`, and `NODE_ENV=production bun repro.ts`.

#### What is the expected behavior?

The second `Bun.serve` throws for each of the three, since `reusePort` defaults to `false`.

#### What do you see instead?

The same with and without `NODE_ENV=production`:

```
{}: refused: Failed to start server. Is port 36069 in use?
{"development":true}: refused: Failed to start server. Is port 36765 in use?
{"development":false}: the second server listens too; answers came from first and second
```

#### Additional information

- The cause is the line of `ServerConfig.rs` above: an explicit `development: false` sets `reuse_port`, which `get_usockets_options` turns into `LIBUS_LISTEN_REUSE_PORT | LIBUS_LISTEN_REUSE_ADDR` in place of `LIBUS_LISTEN_EXCLUSIVE_PORT`. An explicit `reusePort` after it wins.
- On Linux, `SO_REUSEPORT` shares a port only between sockets of the same effective user, so it hands no port to another user. A server of the same user, a second instance of a program among them, takes part of the requests without an error.
- Workaround: pass `reusePort: false` with `development: false`.

## Decision

### Nothing goes to Bun

- The Agent files no issue about it, and comments on no issue or pull request of Bun's, without the user's word, as for [the other bugs](261119_031624-watching-bun-bugs.md#not-reported-yet).

### The workaround stays

- `src/dashboard/server.ts` passes `reusePort: false` with `development: false`, and its comment names this bug and Bun 1.4.4.
- `test/dashboard.test.ts` holds it to its behavior, in "exits with code 1, naming the port, when a device's listener or another rack dashboard holds --port".
- The option stays once a Bun release fixes the bug, since it says what the dashboard wants; its comment then names the release that fixed it.

### Watching

- The bug joins the watch of [the other three](261122_215551-watching-a-third-bun-bug.md#watching), by its rules: when the user asks, and when work moves racku to a newer Bun release, the Agent reads Bun's code and issues for it, runs the reproduction above with that release, and tells the user what changed.
- The reproduction stays in this record, not in the tests: it tests Bun.
- The watch ends with the others' on 2027-01-19: the Agent then runs the reproduction again, and brings the state of all four back to the user.

## Alternatives

- **Report it, as an issue of Bun's.** Bun's maintainers would learn of it. The user chose to watch it, as the other bugs are watched, without the user's word to report.
- **Leave out `development: false`.** Bun would bundle the page in its development mode, with its development tools, which the decision on the dashboard keeps out of the page.
- **Not a bug, but Bun's design.** The line is deliberate, and old. But Bun documents `reusePort` as `false` by default, and says nothing of `development` changing it, while `NODE_ENV=production` turns development off without it: the two paths to production mode disagree, and the documented one doesn't hold.

## Impact

- `src/dashboard/server.ts`: the comment on `reusePort: false` names this bug and the release. No other change to the code or the tests.
- `AGENTS.md`: the line on Bun's bugs under "Current state" names this record.
- Follow-up: the watch, until 2027-01-19.

## Confirmation

- On 2026-11-24 the user asked that the behavior join the Bun bugs under watch if it is truly a bug: "join watching list if truely bug". The Agent found it contradicts Bun's documentation of `reusePort`, and the path of `NODE_ENV=production`, as Background records, so it joins, as the user asked.
