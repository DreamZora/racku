# Decision: Continuous integration on GitHub Actions

Status: accepted

## Background

- The checks, `bun run check`, run by hand on the developer's Linux machine. Nothing checks a push or a pull request.
- The README describes behavior on systems that no test runs on:
  - On macOS, the management endpoint is a Unix socket in the user's state directory.
  - On Windows, it is loopback TCP with a control file under `%LOCALAPPDATA%`. [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#impact) left these defaults untested until the project has a Windows machine, and the README says so.
- The repository is on GitHub, which offers Linux, macOS, and Windows runners. Its macOS minutes count ten times, and its Windows minutes twice, against a private repository's allowance.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since every change is checked the same way, on the systems the README describes; and maintainability, since a failure shows on the change that caused it.

## Decision

- A workflow, `.github/workflows/check.yml`, runs three jobs on GitHub Actions:

  | Job | Runner | Steps | Runs for | Fails the workflow |
  |---|---|---|---|---|
  | Linux | `ubuntu-latest` | `bun install --frozen-lockfile`, then `bun run check` | every push and pull request | yes |
  | macOS | `macos-latest` | `bun install --frozen-lockfile`, then `bun test` | pushes to `main`, pull requests into `main`, and manual runs | yes |
  | Windows | `windows-latest` | `bun install --frozen-lockfile`, then `bun test` | the same as macOS | no |

- Every job installs Bun 1.4.4, the minimum version the package supports, with `oven-sh/setup-bun` at a pinned version.
- The type check, lint, and decision gate don't depend on the system, so only the Linux job runs them.
- The macOS job fails the workflow, because the README describes macOS behavior. A test that fails there is a defect: either the code or the test is fixed.
- The Windows job only reports, because no decision makes Windows a supported platform yet. Its results show what such a decision would have to fix.
- Tests that rely on a facility one system lacks, such as Unix sockets or file modes, are skipped on that system; their expectations don't change. Platform behavior that the README describes keeps a test on the system it describes.
- Until the Windows job passes a test of the Windows defaults, the README keeps saying they are untested.

## Alternatives

- **No CI**: no cost. But a regression shows only when someone runs the checks, and macOS and Windows behavior is never run at all.
- **A local pre-push hook**: no runners needed. But it covers only the developer's own system, and it can be skipped.
- **Every system for every push**: macOS and Windows failures would show earlier. But macOS minutes count ten times, and every push to a feature branch would spend them.
- **Let the Windows job fail the workflow now**: Windows would be supported in practice. But no decision says so, and unknown failures would block every merge.
- **Also test the newest Bun**: it would catch changes in Bun early, such as the module caching that P1 had to work around. It can be added later as a job that only reports. This decision tests the version the package promises.

## Impact

- Every push runs the checks on Linux, and changes to `main` run the tests on macOS and Windows as well.
- The workflow spends Actions minutes of the private repository.
- Making the jobs required for merging is a repository setting on GitHub, outside the workflow.
- The lockfile must keep pointing at the public npm registry, which it does, since the runners install from there.
- The repository gains the `.github/` directory, which AGENTS.md lists.
- Follow-up work once this decision is accepted:
  - `.github/workflows/check.yml`.
  - Platform conditions on the tests that need them, found by the first runs.
  - A test of the Windows defaults that runs only on Windows: `rack start` listens on loopback TCP, writes its control file under `%LOCALAPPDATA%`, and `rack ctl` reaches it.
  - AGENTS.md's repository structure, and the README's "Development" section.

## Implementation

- `.github/workflows/check.yml` holds the three jobs.
  - It pins `actions/checkout` v7.0.1 and `oven-sh/setup-bun` v2.2.0 by commit hash.
  - Each job ends after 15 minutes, so a hung run can't spend the default six hours.
- `test/control.test.ts` skips the Unix socket tests and the file-mode check on Windows. Its test of the Windows defaults runs only on Windows.
- Two fixes for other systems, found by reading the code before the first runs:
  - `CONTROL_DIR` in `test/fixtures/app.ts` sits in `/tmp` outside Windows. The temporary directory of macOS is about 49 characters long, which makes the test sockets about 105 characters, past the 103 that macOS allows. Bun 1.4.4 on Linux accepted socket paths of 120 characters, so the limit doesn't show on Linux.
  - `controlPaths()` in `src/control.ts` joins paths by the rules of the platform it is asked about, so its tests give the same answers on every system.

## Confirmation

- The user accepted this decision on 2026-11-17, as part of the P2 plan, together with implementing it first so that the rest of P2 also runs on macOS.
