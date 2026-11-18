# Decision: Continuous integration on main and on request

Status: superseded — replaced by [261118_015210-ci-with-windows.md](261118_015210-ci-with-windows.md)

## Background

- [Continuous integration on GitHub Actions](261117_063301-continuous-integration.md) runs the Linux job for every push and pull request. It runs the macOS and Windows jobs for pushes to `main`, pull requests into `main`, and manual runs.
- The repository is private, on GitHub Free. [GitHub's billing page](https://docs.github.com/en/billing/concepts/product-billing/github-actions), read on 2026-11-17, gives it $12 of Actions compute a month, and charges each minute of a standard runner:

  | Runner | Per minute | Minutes that $12 buys |
  |---|---|---|
  | Linux, 2 cores | $0.006 | 2 000 |
  | Windows, 2 cores | $0.010 | 1 200 |
  | macOS, 3 or 4 cores | $0.062 | about 190 |

- For jobs of equal length, a run of all three jobs costs 13 times as much as the Linux job alone, and the macOS job takes about four-fifths of that.
- Every commit passes `bun run check` on the developer's Linux machine before it is pushed, as AGENTS.md's workflow requires. A Linux run for each push mostly repeats that check. While a pull request into `main` is open, each push to its branch also runs macOS.
- The user asked on 2026-11-17 not to run CI for every commit, so that the allowance lasts.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since `main` is still checked on every system the README describes.

## Decision

- The workflow `.github/workflows/check.yml` runs on two events only:
  - A push to `main`, which a merge produces.
  - A manual run, on any branch: "Run workflow" on the repository's Actions tab, or `gh workflow run check.yml --ref <branch>`.
- Pushes to other branches and pull requests start no runs.
- Each run runs all three jobs:

  | Job | Runner | Steps | Fails the workflow |
  |---|---|---|---|
  | Linux | `ubuntu-latest` | `bun install --frozen-lockfile`, then `bun run check` | yes |
  | macOS | `macos-latest` | `bun install --frozen-lockfile`, then `bun test` | yes |
  | Windows | `windows-latest` | `bun install --frozen-lockfile`, then `bun test` | no |

- A new run cancels a run of the same branch that is still in progress, since the new one checks everything the old one would.
- Each job ends after 15 minutes, so a hung macOS job costs at most $0.93.
- A change to platform behavior, such as paths, sockets, signals, or file modes, gets a manual run on its branch before it merges. Other changes are checked on `main` once they merge, and a failure there is fixed before other work.
- These rules carry over from the decision this one replaces:
  - Every job installs Bun 1.4.4, the minimum version the package supports, with `oven-sh/setup-bun` at a pinned version.
  - Only the Linux job runs the type check, lint, and decision gate, since they don't depend on the system.
  - The macOS job fails the workflow, because the README describes macOS behavior. A test that fails there is a defect: either the code or the test is fixed.
  - The Windows job only reports, because no decision makes Windows a supported platform yet.
  - Tests that rely on a facility one system lacks, such as Unix sockets or file modes, are skipped on that system; their expectations don't change. Platform behavior that the README describes keeps a test on the system it describes.
  - Until the Windows job passes a test of the Windows defaults, the README keeps saying they are untested.

## Alternatives

- **Keep the Linux job on every push**: a failure would show on the branch that caused it. But the same check already ran before the commit, and the user asked for no run per commit.
- **Also run on pull requests into `main`**: a pull request would show its checks. But every push to its branch would run macOS again, the most expensive job.
- **Run macOS and Windows only by hand, and Linux on `main`**: a merge would cost a thirteenth as much. But the macOS behavior that the README describes would run only when someone remembers to start it.
- **Only manual runs**: the least spending. But `main` could break on any system without anyone noticing.
- **Skip pushes that change only documentation**: fewer runs on `main`. But the README is tested and the decision gate checks `.agents/`, so the filter would need exceptions that are easy to get wrong.

## Impact

- A push to a feature branch spends nothing. Each push to `main` spends one run of the three jobs: about $0.23 if each job takes 3 minutes, so the allowance covers about 50 merges a month.
- A failure on macOS or Windows shows on `main` after the merge, unless the branch got a manual run first. The local `bun run check` stays the check of every commit.
- A pull request shows checks only for a commit that a manual run checked. Requiring the jobs for merging, a repository setting, would require such a run.
- It replaces [Continuous integration on GitHub Actions](261117_063301-continuous-integration.md). The references in `.github/workflows/check.yml`, `test/control.test.ts`, and AGENTS.md move to this decision.
- Follow-up work once this decision is accepted:
  - `.github/workflows/check.yml`: the two events, the cancellation of older runs, and no conditions on the jobs.
  - The README's "Development" section, and AGENTS.md's current state.
  - The status line of the replaced decision.

## Implementation

- `.github/workflows/check.yml` holds the three jobs.
  - It runs on `push` to `main` and on `workflow_dispatch`.
  - Its concurrency group is `check-${{ github.ref }}`, with `cancel-in-progress`.
  - It pins `actions/checkout` v7.0.1 and `oven-sh/setup-bun` v2.2.0 by commit hash.
- `test/control.test.ts` skips the Unix socket tests and the file-mode check on Windows. Its test of the Windows defaults runs only on Windows.
- `CONTROL_DIR` in `test/fixtures/app.ts` sits in `/tmp` outside Windows, which keeps the test sockets within the 103 characters that macOS allows.

## Confirmation

- The user accepted this decision on 2026-11-17, after asking that CI not run for every commit.
