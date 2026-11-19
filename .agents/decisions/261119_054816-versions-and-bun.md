# Decision: Informal versions until the first release, and the Bun versions rack42u follows

Status: accepted

## Background

- rack42u has five tags, v0.1.0 to v0.5.0, each made at the user's word. Breaking changes went into two of them: four commits marked `!` into v0.2.0, and one into v0.4.0.
- The repository is private, on GitHub, and rack42u is not on npm.
- On 2026-11-19, after the Agent assessed whether rack42u is ready as a basic framework, the user decided:
  - "Keep it private for now."
  - "With an informal version, API breakage is always possible, and tags can be deleted; wait until we decide to cut a formal release before tagging and making it public."
  - "I don't think making it publicly installable is urgent for now; use the private repository to handle dependencies first."
  - "Regarding the Bun version, I think every major version of rack42u needs to be able to upgrade rather than being pinned to one specific version. Before release, it should be able to upgrade and switch versions at any time. I think you can write the Bun version control into AGENTS.md in a reasonable way for me."
- Where the Bun version is named today:
  - `engines.bun` in `package.json` is `>=1.4.4`, and `@types/bun` is 1.4.4, as [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#toolchain-and-dependencies) decides.
  - Each of the three CI jobs installs Bun 1.4.4, as [Continuous integration with Windows checked](261118_015210-ci-with-windows.md#decision) decides.
  - The README requires "Bun 1.4.4 or later", and `AGENTS.md` names 1.4.4 as the minimum, with the reason.
- So "or later" is claimed without a test. Bun 1.4.5 came out on 2026-11-19, and the tests of rack42u haven't run on it.
- [Watching two Bun bugs before reporting them](261119_031624-watching-bun-bugs.md#watching) asks for a decision before rack42u requires a Bun release that fixes one of the bugs it works around.
- On 2026-11-19, Bun 1.4.4 installed rack42u as a git dependency from a local clone, `git+file://<clone>#v0.5.0`, with the `rack` command. An app on that install ran, with `start()` and with `rack start`. A git install copies the whole repository, whatever `files` in `package.json` lists.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since a Bun release that breaks rack42u fails a test instead of an app;
  - maintainability, since one rule says how the minimum moves, and a test keeps every place that names it in step.

## Decision

### Informal versions

- rack42u has no formal release yet. Its versions until the first one, v0.5.0 and any later 0.x, are informal:
  - Any of them may break the API. A breaking change still gets `!` and a `BREAKING CHANGE:` footer, and raises the minor version, as the global rules require.
  - Their tags aren't promises, and the user may delete them.
  - An informal version is tagged only at the user's word, as v0.1.0 to v0.5.0 were.
- The repository stays private, and rack42u isn't published to npm. An app depends on rack42u through git: by a URL of the repository with a tag or a commit, for those with access to it, or by a URL of a local clone.
- The user decides when the first formal release is cut. A decision for it then says what the release promises, such as which API stays stable, and how rack42u is published. The release is tagged, and the repository made public, then.

### A minimum Bun, not a pinned one

- rack42u names one minimum Bun version, as `>=<minimum>` in `engines.bun`, and supports every later Bun release. Nothing pins one release or checks for an exact version.
- `@types/bun` has the minimum's version, so the type check sees only the APIs that the minimum has.
- Five places name the minimum: `engines.bun`, `@types/bun`, the CI workflow, the README's Requirements, and `AGENTS.md`. A test checks that they name the same version, so they change together.

### What CI tests

- The Linux, macOS, and Windows jobs keep installing the minimum, so the minimum is tested on all three systems.
- A fourth job, "Linux, latest Bun", installs the latest Bun release on `ubuntu-latest`, and runs `bun install --frozen-lockfile` and `bun test`. It fails the run when it fails, as the others do, and ends after 15 minutes.
- A failure of that job is a defect, as any failing test is. rack42u is fixed to work on the new release, or works around a bug of Bun, with a record such as [Watching two Bun bugs before reporting them](261119_031624-watching-bun-bugs.md) keeps.

### Moving the minimum

- Until the first formal release, the minimum may move to another Bun release at any time, up or down, when work needs it: for a fix or an API of a newer release, to drop a workaround, or to follow Bun.
  - The change moves the five places together, gets a manual CI run on its branch before it merges, and says in its commit why the minimum moves.
  - It needs no decision of its own, a move to a release that fixes a watched bug included. The workaround for a bug of Bun goes once the minimum has the fix, in the same change or a later one.
- After the first formal release, each major version of rack42u can still raise its minimum, in a minor version whose tag says so, so that no major version is pinned to one Bun release. The decision for the first release may refine this.

### Developing with Bun

- Contributors and agents develop with any Bun at or above the minimum. Code uses only the APIs that the minimum has, which the type check and the CI jobs on the minimum hold it to.
- Code that exists only because of a bug of a Bun release names the bug and the release, as `src/firmware.ts` does, so that it can go once the minimum is past it.

## Alternatives

- **Pin one Bun release,** with an exact `engines.bun` or `packageManager`: every run would use the same Bun, but an app on a newer Bun wouldn't be supported, which the user ruled out.
- **Test the latest release on all three systems:** it would also catch the regressions of a newer Bun on macOS and Windows, but double the cost of a run, mostly macOS's, which [the CI decision](261118_015210-ci-with-windows.md#decision) bounds. A move of the minimum still runs all three systems on the new one.
- **A latest job that doesn't fail the run:** a new Bun release couldn't turn `main` red, but a failure that no one has to look at gets ignored, and "or later" would stay untested.
- **Keep the minimum at the latest release:** one version to test, but each Bun release would drop the one before for every app, without a reason of rack42u's.
- **A decision for every move of the minimum:** each move would have a record of its reasons, but the user asked that the version can move at any time before the release. The commit and the CI run hold the reason and the evidence.
- **Publish informal versions to npm, or make the repository public now:** the user chose to keep it private until the first formal release.

## Impact

- A Bun release that breaks rack42u fails the next run, on Linux, instead of an app. Each run costs one more Linux job of a few minutes.
- A Bun release can turn `main` red without any change to rack42u. Fixing it then comes before other work, as the CI decision requires for any failure on `main`.
- A regression of a newer Bun on macOS or Windows alone shows up only once the minimum moves to that release.
- Moves of the minimum leave no decision behind; their commits and CI runs are the record.
- Until the first formal release, an app should expect breaking changes in any version, and depend on a tag or a commit.
- A check at startup that refuses an older Bun would turn the crash of an old Bun into an explicit error. It would change the public behavior, so it needs a decision of its own.
- How the accepted decisions this one affects are handled once it is accepted:
  - [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#toolchain-and-dependencies): its minimum in `engines.bun`, with `@types/bun` matching, stands, and this decision adds how the minimum moves. It stays as it is, with this note.
  - [Continuous integration with Windows checked](261118_015210-ci-with-windows.md#decision): its three jobs stay on the minimum, and the latest job joins them. It stays as it is, with this note, and this decision comes first where they differ.
  - [Watching two Bun bugs before reporting them](261119_031624-watching-bun-bugs.md#watching): moving the minimum to a release that fixes one of its bugs needs no decision of its own. It stays as it is, with this note, and this decision comes first where they differ.
- Changes once it is accepted:
  - `.github/workflows/check.yml`: the minimum named once for the three jobs, and the latest job.
  - `test/bun-version.test.ts`: checks that the five places name one minimum, and points back at the README's Requirements.
  - The README's Requirements: "Bun 1.4.4 or later. CI tests 1.4.4 on every system, and the latest Bun release on Linux.", and a line that versions before the first formal release may break the API.
  - `AGENTS.md`: the section below, which takes over the minimum's line from "Current state":

    ```markdown
    ## Versions

    [Informal versions until the first release, and the Bun versions rack42u follows](.agents/decisions/261119_054816-versions-and-bun.md) decides these rules.

    - rack42u has no formal release yet. Until the user cuts the first one, every version is informal: any may break the API, a version is tagged only at the user's word, and the repository stays private. Apps depend on rack42u through git.
    - rack42u names a minimum Bun version, not a pinned one, and supports every later release.
      - The minimum is 1.4.4: Bun 1.3.13 crashes when a Worker that used a transferred `MessagePort` ends, and the backplane's data channel is such a port.
      - `engines.bun` names it as `>=1.4.4`. `@types/bun`, `.github/workflows/check.yml`, the README's Requirements, and this file name the same version, and `test/bun-version.test.ts` checks that they agree.
      - CI tests the minimum on Linux, macOS, and Windows, and the latest Bun release on Linux. A failure on the latest release is a defect: fix rack42u, or work around the bug of Bun and record it.
      - Until the first formal release, move the minimum whenever work needs it, such as for a fix, an API, or a workaround that can go. Move the five places in one change, run CI by hand on its branch, and say why in the commit. After the release, a major version can still raise its minimum, in a minor version.
      - Use only the Bun APIs that the minimum has. Code that exists for a bug of a Bun release names the bug and the release.
    ```

## Confirmation

- The user accepted this decision on 2026-11-19, together with the two other decisions drafted that day, after reviewing them: "Approved, all of them. Get to work."
  - The Agent had pointed out that the job on the latest Bun runs on Linux only, to keep the cost of a run down, and asked the user to say if all three systems should run it. The user approved the decision as it stands.
