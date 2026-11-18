# Decision: When a test may change

Status: accepted

## Background

- `AGENTS.md` forbade changing a test to make it pass: "Do not modify or delete tests to make them pass. Tests may change only when an `accepted` decision covers the behavior change." No decision recorded that rule or its reasons.
- The rule keeps a failing test from being bent to fit the code, which is how defects slip through. But it had no exception for a test that is itself wrong, so fixing such a test either needed a decision or broke the rule.
- The CI run on `main` at `83e5f54` on 2026-11-18, and a local run on two CPU cores after it, showed both kinds of failure:
  - `release()` in `test/ending.test.ts` opened a FIFO once to tell whether a thread was blocked on it. A probe showed that JavaScriptCore keeps interrupting a terminated thread's open, so one attempt missed a blocked thread in 1 or 2 of 30 trials under load. The test was wrong; the code was right.
  - Two tests in `test/links.test.ts` took the time the main thread became blocked just after the call they sent, so a device could start a millisecond "before" the block. The tests were wrong; the code was right.
  - A test in `test/watchdog.test.ts` read a fallback `online`. It looked like a timing problem of the test, but the test was right: `status()` did report a fallback `online` while its install finished.
- Telling these apart takes evidence, not the wish to see a test pass.

## Decision

- Don't change or delete a test just to make it pass. A failing test is first taken as a report of a defect in the code.
- A test may change when an `accepted` decision covers the behavior change that it pins, or when it is clear that the test itself is wrong, for example when:
  - it measures in a way that fails while the behavior is right, such as a race in its own timing;
  - it expects something that the documentation and the decisions contradict.
- Clear means shown. The commit that changes the test says what was wrong with it and gives the evidence, such as a reproduction, or a probe showing that the behavior is right while the test fails.

## Alternatives

- **Keep the rule as it was**: every fix to a wrong test would need a decision, which is heavier than the fix, or would break the rule.
- **Let a test change whenever it seems wrong**: a failing test could be bent to fit a defect, which is what the rule is there to prevent.

## Impact

- The rule in `AGENTS.md` changes, and links to this decision.
- A commit that changes a test without a decision covering the change explains what was wrong with the test and how that was shown.

## Implementation

- `AGENTS.md`, "Prohibitions".
- The first test changes under this rule are the `release()` helper of `test/ending.test.ts` and the blocked-main-thread tests of `test/links.test.ts`. Their commit messages give the evidence.

## Confirmation

- The user decided this rule on 2026-11-18: "don't change tests just to make them pass, unless it's clear that the test case itself is wrong." The agent wrote this record from that instruction.
