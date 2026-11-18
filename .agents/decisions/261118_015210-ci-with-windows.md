# Decision: Continuous integration with Windows checked

Status: accepted

## Background

- [Continuous integration on main and on request](261117_182058-ci-on-main-and-on-request.md) runs the workflow for pushes to `main` and for manual runs. Its Windows job only reports, because no decision made Windows a supported platform.
- [Windows as a supported platform](261118_015204-windows.md) makes Windows supported, with the README describing its behavior, so a test that fails there is a defect, as on macOS.
- The costs that the replaced decision measured stand: a minute of a Windows runner costs $0.010, against $0.006 on Linux and $0.062 on macOS. The Windows job already runs in every run.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since `main` is checked on every system the README describes.

## Decision

- The workflow `.github/workflows/check.yml` runs on two events only:
  - A push to `main`, which a merge produces.
  - A manual run, on any branch: "Run workflow" on the repository's Actions tab, or `gh workflow run check.yml --ref <branch>`.
- Pushes to other branches and pull requests start no runs.
- Each run runs three jobs, and each fails the workflow when it fails:

  | Job | Runner | Steps |
  |---|---|---|
  | Linux | `ubuntu-latest` | `bun install --frozen-lockfile`, then `bun run check` |
  | macOS | `macos-latest` | `bun install --frozen-lockfile`, then `bun test` |
  | Windows | `windows-latest` | `bun install --frozen-lockfile`, then `bun test` |

- A new run cancels a run of the same branch that is still in progress, since the new one checks everything the old one would.
- Each job ends after 15 minutes, so a hung macOS job costs at most $0.93.
- A change to platform behavior, such as paths, sockets, signals, or file modes, gets a manual run on its branch before it merges. Other changes are checked on `main` once they merge, and a failure there is fixed before other work.
- These rules carry over from the decision this one replaces:
  - Every job installs Bun 1.4.4, the minimum version the package supports, with `oven-sh/setup-bun` at a pinned version.
  - Only the Linux job runs the type check, lint, and decision gate, since they don't depend on the system.
  - Tests that rely on a facility one system lacks, such as Unix sockets or file modes, are skipped on that system; their expectations don't change. Platform behavior that the README describes keeps a test on the system it describes.
- A test that fails on any of the three systems is a defect: the code or the test is fixed, as [When a test may change](261118_011457-changing-tests.md) decides.

## Alternatives

- **Keep the Windows job reporting only**: a regression on a supported system would not fail the run.
- **Check Windows only in manual runs**: no saving, since a Windows minute is the second cheapest, and `main` would no longer be checked on every supported system.

## Impact

- The cost of a run doesn't change.
- A failure on Windows now fails the run on `main`, and a manual run on a branch, as a failure on macOS does.
- It replaces [Continuous integration on main and on request](261117_182058-ci-on-main-and-on-request.md). The references in `.github/workflows/check.yml`, `test/control.test.ts`, and `AGENTS.md` move to this decision.
- Follow-up work once this decision is accepted:
  - `.github/workflows/check.yml`: the Windows job without `continue-on-error`, once the Windows job passes.
  - The README's "Development" section, and AGENTS.md's current state.
  - The status line of the replaced decision.

## Confirmation

- The user accepted this decision on 2026-11-18, after asking that Windows be supported.
