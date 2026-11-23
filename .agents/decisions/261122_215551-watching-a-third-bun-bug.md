# Decision: Watching a third Bun bug, which Bun's main already fixes

Status: accepted

## Background

- racku works around a third bug of Bun, which the third round of trials found, as [issue #23](https://github.com/DreamZora/racku/issues/23) reports: in Bun 1.4.4 and 1.4.5, a test that awaited one call of a device, then expected the next call to reject with `expect(...).rejects`, waited until that call timed out. The main thread now handles what device Workers post in the dispatch of a `BroadcastChannel`'s message, with the `Relay` in `src/instance.ts`, as [the trials of the newer features](261122_005441-trials-of-the-newer-features.md#implementation) record.
- On 2026-11-22 the user asked for a record of it, and for no report to Bun: "#23 write up(do not make issue to bun repo)".
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since a test of a device must get the device's answers, and a wait that lasts until a timeout hides them;
  - maintainability, since the `Relay` exists only for a bug of Bun, and this record says what would let it go.

### What Bun has on 2026-11-22

- [#37189](https://github.com/oven-sh/bun/issues/37189), open since 2026-08-08: `await expect(p).rejects` deadlocks when the test reaches it from the continuation of a Worker's earlier reply, a regression in 1.3.14 from #29937. [#43819](https://github.com/oven-sh/bun/issues/43819), the same with `.resolves`, was closed as completed on 2026-11-17.
- [#44833](https://github.com/oven-sh/bun/pull/44833), "bun test: Vitest compatibility", merged into Bun's `main` on 2026-10-31, makes `.resolves` and `.rejects` return a promise instead of running the event loop inside the matcher. On 2026-11-02, a comment from Jarred Sumner's account, which says an AI wrote it, and one from Bun's bot `robobun` found the tests of #37189 passing on canary.
- Neither release that racku supports has #44833: it came into `main` 61 commits after 1.4.4, and 1.4.5 is 1.4.4 with 24 other commits. The canary of 2026-11-22, `1.4.6-canary.1+3eb8a1b26`, has it.
- [#37190](https://github.com/oven-sh/bun/pull/37190), from `robobun` since 2026-08-08, fixes the cause in the message channels too. On 2026-11-02 it was converted to a draft while Bun's maintainers decide whether they want it, since `robobun` found no path that users reach to the cause once #44833 is in.

### The bug, as racku reproduces it

A record in the sections of Bun's bug template, like the reports of [the other two](261119_031624-watching-bun-bugs.md), though not for filing.

**Title:** `expect(p).rejects` and `.resolves` get no further message of a `MessagePort` or a `Worker` when the test resumed from one of its messages

#### What version of Bun is running?

1.4.4 (38afee6c8) and 1.4.5 (a7733435c)

#### What platform is your computer?

Linux 7.0.0-43-generic x86_64, Ubuntu 26.04.1 LTS

#### What steps can reproduce the bug?

`worker.ts`:

```ts
// Answers each number that comes on its port with "pong <number>", 10 ms later.
declare var self: Worker;
self.onmessage = (event: MessageEvent<MessagePort>) => {
  const port = event.data;
  port.onmessage = (message: MessageEvent<number>) => {
    setTimeout(() => port.postMessage(`pong ${message.data}`), 10);
  };
};
```

`repro.test.ts`:

```ts
import { expect, test } from "bun:test";

// Asks a Worker twice on a MessagePort. The first answer resumes the test in the dispatch of
// the port's message; expect().rejects then waits for the second answer.
test("expect().rejects gets the second answer", async () => {
  const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  const { port1, port2 } = new MessageChannel();
  worker.postMessage(port2, [port2]);
  const waiting: ((answer: string) => void)[] = [];
  port1.onmessage = (event: MessageEvent<string>) => waiting.shift()?.(event.data);
  const ask = (n: number) =>
    new Promise<string>((resolve) => {
      waiting.push(resolve);
      port1.postMessage(n);
    });

  expect(await ask(1)).toBe("pong 1");
  const started = performance.now();
  const second = new Promise((_, reject) => {
    waiting.push((answer) => reject(new Error(answer)));
    port1.postMessage(2);
    setTimeout(() => reject(new Error("no answer within 2 s")), 2000);
  });
  try {
    await expect(second).rejects.toThrow("pong 2");
  } finally {
    console.log(`expect().rejects waited ${Math.round(performance.now() - started)} ms`);
    worker.terminate();
  }
});
```

Run `bun test ./repro.test.ts`.

#### What is the expected behavior?

The test passes: the second answer comes about 10 ms after its question, as the first does.

#### What do you see instead?

```
expect().rejects waited 2001 ms
error: expect(received).toThrow(expected)

Expected substring: "pong 2"
Received message: "no answer within 2 s"

(fail) expect().rejects gets the second answer [2014.33ms]
```

`expect(...).rejects` waited until the timer rejected the promise. The answer wasn't lost: a listener that logged when each message was dispatched showed `pong 2` dispatched at 2001 ms, as the wait ended.

The same case, varied, gave the same results on 1.4.4 and 1.4.5:

| Channel of the answers | How the test waits | Where the test resumed before | Wait | Outcome |
|---|---|---|---:|---|
| `MessagePort` | `.rejects` | a message | 2 000 ms | no answer |
| `MessagePort` | `.resolves` | a message | 2 000 ms | no answer |
| The `Worker`'s own | `.rejects` | a message | 2 000 ms | no answer |
| The `Worker`'s own | `.resolves` | a message | 2 000 ms | no answer |
| `BroadcastChannel` | `.rejects` or `.resolves` | a message | 10 ms | `pong 2` |
| `MessagePort` | `.rejects` | a timer | 10 ms | `pong 2` |
| `MessagePort` | `expect(await p)` | a message | 10 ms | `pong 2` |

On the canary of 2026-11-22, every row took 10 ms, and the test passed.

#### Additional information

- The cause, as we read it at `bun-v1.4.4`:
  - `process_promise` (`src/runtime/test_runner/expect.rs`, line 492) waits for the promise of `.resolves` and `.rejects` with `wait_for_promise` (line 513), which runs the event loop inside the matcher's call.
  - `MessagePortPipe::send` (`src/jsc/bindings/webcore/MessagePortPipe.cpp`, line 22) adds a message to the inbox of the receiving side, and posts a task to drain it only when `DrainScheduled` isn't set (line 38).
  - `MessagePortPipe::drainAndDispatch` (line 67) dispatches the inbox's messages one at a time, drains the microtasks after each (line 163), and clears `DrainScheduled` once it finds the inbox empty.
  - A test that awaited an answer resumes in that microtask drain, with `drainAndDispatch` below it on the stack. While it waits in the matcher, the next answer goes into the inbox with no task posted, and the drain that would dispatch it goes on only once the wait has ended.
  - A `Worker`'s own channel works the same way: `WorkerMessagingProxy::postMessageToWorkerObject` (`src/jsc/bindings/webcore/WorkerMessagingProxy.cpp`, line 437) posts a drain only when `drainScheduled` isn't set, and `drainInbox` (line 299) drains the microtasks after each message (line 341), and clears `drainScheduled` once its queue is empty (line 310).
  - `BunBroadcastChannelRegistry::post` posts one task per message and subscriber, so a wait in the matcher still runs it.
  - #37190 names the same cause.
- Workaround: hand each message to a task that runs in the dispatch of a `BroadcastChannel`'s message, so that code that resumes from the handling isn't inside the drain of its channel.

## Decision

### Nothing goes to Bun

- Bun has the bug as #37189, and its `main` fixes it. The Agent files no issue about it, and comments on no issue or pull request of Bun's, without the user's word, as the user decided.

### The workaround stays

- The `Relay` stays while racku supports a Bun release whose `.resolves` and `.rejects` run the event loop inside the matcher, as 1.4.4 and 1.4.5 do, and goes once a release has the fix, as [Once a Bun release has the fix](#once-a-bun-release-has-the-fix) says.
- `test/bench.test.ts` holds it to its behavior, in "expect().rejects and .resolves get the outcome of a call that follows an awaited one".

### Watching

- The bug joins the watch of [the other two](261119_031624-watching-bun-bugs.md#watching), by its rules: when the user asks, and when work moves racku to a newer Bun release, the Agent reads #37189, #44833, and #37190, runs the reproduction above with that release, and tells the user what changed.
- The reproduction stays in this record, not in the tests: it tests Bun.

### Once a Bun release has the fix

The user allowed both steps in advance, as [Confirmation](#confirmation) records, so they need no further decision.

- When a Bun release has #44833, and the reproduction above passes with it, racku requires that release, and the `Relay` goes:
  - The minimum moves to that release in every place that names it, which `test/bun-version.test.ts` checks agree, in a minor version whose release notes say so, as [After 1.0.0](261122_005312-first-formal-release.md#after-100) allows.
  - The `Relay` goes from `src/instance.ts`, and the main thread handles what device Workers post in the dispatch of their messages again.
- The cause in the message channels stays until #37190 or another change fixes it. So the `Relay` goes only if racku's tests pass without it on that release, on Linux, macOS, and Windows, in a CI run by hand on the change's branch, the test above among them, which stays. If they don't, the minimum and the `Relay` stay as they are, and the Agent brings the failures to the user.

### Until 2027-01-19

- The watch of this bug ends with that of the other two, on 2027-01-19: the Agent then runs the reproduction again, and brings the state of all three back to the user.

## Alternatives

- **Report it, or add the case of a `MessagePort` to #37189.** Bun has the issue and a fix on `main`, and #37190 covers `MessageChannel`s as well. The user chose to report nothing.
- **Drop the `Relay`, and have apps await a call before they check its error.** The [testing guide](../../docs/guides/testing.md#members-of-a-bench) checks a call's error with `expect(...).rejects.toMatchObject({ code })`, and the trial apps of #23 wrote such tests; with the bug, each waits until its call times out.
- **Require Bun's canary.** racku names a release as its minimum, and no release has the fix yet.
- **Decide again once a release has the fix.** As first proposed, this record left raising the minimum, and removing the `Relay`, to a new decision then. The user allowed both in advance, so the change waits only on Bun and on racku's tests.

## Impact

- `src/instance.ts`: the `Relay`'s comment names Bun's issue, and this decision. No change to the tests or the documentation.
- `AGENTS.md`: the line on Bun's bugs under "Current state" names this record.
- Follow-up: when a Bun release has #44833, the change that [Once a Bun release has the fix](#once-a-bun-release-has-the-fix) describes, in the places that name the minimum and in `src/instance.ts`.

## Confirmation

- On 2026-11-23 the Agent asked the user whether they accept this decision as written. The user's answer: "Allow raising racku's minimum Bun version and removing the workaround once Bun includes the fix." The record had left both steps to a new decision; [Once a Bun release has the fix](#once-a-bun-release-has-the-fix) allows them, as the user did, and the decision is accepted with that change.
