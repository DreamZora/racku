# Decision: The first formal release, 1.0.0, published to npm from a public repository

Status: accepted

## Background

- [Informal versions until the first release, and the Bun versions rack42u follows](261119_054816-versions-and-bun.md#informal-versions) keeps every version informal until the user cuts the first formal release. It leaves two things to a decision for that release: what the release promises, such as which API stays stable, and how rack42u is published. The release is tagged, and the repository made public, then.
- On 2026-11-21 the user asked whether `main` is ready for a release. The answer listed what a formal release still needs:
  - this decision;
  - a security review of the management endpoint, its tokens, and the device files that load from outside;
  - a trial round on the features that came after the second round;
  - package metadata.
- On 2026-11-22 the user said "OK, Go ahead" to those, and to the informal tag v0.6.0.
- The state on 2026-11-22, at v0.6.0:
  - CI passes on Linux, macOS, and Windows with Bun 1.4.4, and on Linux with the latest Bun: 661 tests, of which 2 to 5 skip by platform.
  - Every section of `docs/guides/` and `docs/reference/` is held by a test, and every accepted decision is implemented.
  - No issue is open: the 22 that two trial rounds filed are closed.
  - Not built yet, as the README says: devices in child processes, connected racks, and a management dashboard.
- No app outside this repository has run on rack42u yet. The apps so far are the examples and the trial apps.
- The name `rack42u` is free on npm: its registry answered 404 for it on 2026-11-22.
- A public repository shows its whole history:
  - every commit's author name and email;
  - local paths, such as a home directory, in six lines of `.agents/trials/`, where the trial apps installed rack42u from a clone.

## Decision

### The version, and what it promises

- The first formal release is **1.0.0**. From it on, rack42u follows semantic versioning:
  - **Major:** any change that breaks the public API.
  - **Minor:** an addition, such as a new export, option, connector, or error code.
  - **Patch:** a fix that changes no documented behavior.
- **The public API** is what `docs/reference/` documents:
  - the exports of `rack42u`, `rack42u/std`, and `rack42u/bench`, with their types, as [API](../../docs/reference/api.md) lists them;
  - manifests, as `rack()`, `slot()`, and the fields of placed and scanned racks give them, and the format of the plan file;
  - the commands, options, environment variables, and exit codes of the `rack` command and of an executable that `rack compile` makes, as [The rack command](../../docs/reference/cli.md) lists them;
  - the requests and answers of the management endpoint, which `rack ctl` sends;
  - the standard connectors `kv/v1`, `sql/v1`, `http/v2`, and `commands/v1`, whose versions are in their names;
  - the codes of [Error codes](../../docs/reference/errors.md), and the shapes of `status()`, `metrics()`, `history()`, and the JSON log entries, as [Reports](../../docs/reference/reports.md) gives them;
  - the bounds of [Limits](../../docs/reference/limits.md). A minor version may relax a bound; only a major version may tighten one.
- Outside the promise, and free to change in any version:
  - the wording of log and error messages, but not their codes;
  - the layout of `.rack/`, and the firmware bundles;
  - the messages between the main thread and the Workers;
  - timings within the documented bounds;
  - everything under `src/` that the entry points don't export.
- **Deprecation:** a part of the API that is to go is marked `@deprecated`, and the documentation says so, in a minor version before the major version that removes it.
- **Not in 1.0.0:** devices in child processes, connected racks, and a management dashboard. Each needs its own decision, and can come in a minor version.

### Before 1.0.0

The release is tagged only once all of these hold, on the commit that becomes 1.0.0:

1. **The security review.** Every finding of high or medium severity is either fixed, or stated as a limit in [Limits](../../docs/reference/limits.md) with the user's agreement. [Fixes from the security review before 1.0.0](261122_011655-security-review-fixes.md) lists the findings, and what comes of each.
2. **A trial round** on the features since the second round: `rack compile`, `--watch`, hot-plug directories, every needs, and `commands/v1`, as [Trials of the features since the second round](261122_005441-trials-of-the-newer-features.md) decides. Its issues are either fixed, or left for a later version with the user's agreement.
3. **The package:**
   - `package.json` has `keywords`, `homepage`, and `bugs` besides what it has now.
   - The tarball that `bun pm pack` makes holds only what `files` names.
   - A test installs that tarball into an app, and runs and type-checks the app, as the test of getting started does with a clone.
4. **`SECURITY.md`** says how to report a vulnerability: privately, through GitHub's private vulnerability reporting, which is turned on when the repository goes public.
5. **The history:**
   - A scan of the whole history finds no secret, such as a token or a key.
   - The user agrees to what the history shows of them, such as the author's name and email, and the local paths in `.agents/trials/`.
6. **CI** passes on all four jobs, and `net-tool.yml` passes on all three systems.

### The day of the release

In this order:

1. The Agent sets the version to 1.0.0, in a commit of its own, and tags v1.0.0 at the user's word, as earlier versions were tagged.
2. The user makes `DreamZora/rack42u` public, and turns on private vulnerability reporting.
3. The user publishes the package to npm as `rack42u`, under their npm account, with `bun publish` from a clean clone of the tag.
4. The Agent makes a GitHub release from the tag, with the tag's message.

### The package

- The package ships rack42u's TypeScript sources, as git installs do now. It runs only on Bun, which runs the sources as they are, and `engines.bun` names the minimum.
- Apps add rack42u from npm, so getting started, the README, and the skill change from the git URL to `bun add rack42u`. A URL of the repository with a commit still works, for an unreleased commit.
- The informal tags, v0.1.0 to v0.6.0, stay as history, and promise nothing, as before.

### After 1.0.0

- **Tags:** every version is tagged at the user's word, as now, and published by the user.
- **Fixes:** fixes go into the newest minor version only. A fix for a vulnerability comes as a patch, and its release notes say so.
- **Bun:** each major version follows Bun by a minimum, which a minor version may raise, with release notes that say so, as [Moving the minimum](261119_054816-versions-and-bun.md#moving-the-minimum) allows after the first release.
- **Source:** the repository's `main` is what the next version releases.

### What can go wrong

| Failure | Outcome |
|---|---|
| A prerequisite isn't met | The release waits. |
| The scan finds a secret in the history | The repository stays private, and the secret is revoked. The user decides how to remove it: rewriting the history changes every commit and tag. |
| The repository can't be made public, or the package can't be published | The tag stays, and the step is repeated once its cause is fixed. The steps before it need no undoing. |
| A published version holds a wrong file or a defect | It is deprecated on npm with a message naming the version to use instead, and a patch follows. npm removes a published version only within narrow limits, so nothing counts on that. |
| The name `rack42u` is taken on npm before the release | The user picks another name, and this decision changes. |

### Where this decision changes others

[Informal versions](261119_054816-versions-and-bun.md#informal-versions): its informal versions end at 1.0.0, after which the repository is public and rack42u is published to npm, as this decision says. That decision stays for its rules on Bun, and this decision comes first where they differ.

## Alternatives

- **A public 0.x first, such as 0.7.0, with no promise.**
  - For: apps outside this repository could try rack42u before its API is promised.
  - Against: the versions decision doesn't call such a release formal, and users can't rely on any version of it.
  - Not chosen, since the promise is what an app needs to build on rack42u. A breaking change after 1.0.0 still has a way: a major version. If the user wants outside apps first, only this decision's version and promise change.
- **A public repository, without npm.** Apps would keep adding rack42u through git, which takes no range such as `^1.0.0`, so an app gets a fix only by changing its URL. A git install also clones the repository, which takes longer than a download. Not chosen.
- **Publishing JavaScript built from the sources, with type declarations.** It suits runtimes besides Bun, which rack42u doesn't support, and adds a build to every release. Not chosen.
- **Publishing from a CI workflow with npm's trusted publishing.** It ties each package to the workflow run that built it, with provenance, and needs no npm token on any machine. But it needs a workflow, and npm's setup for a package that exists. A later decision can add it. Not chosen for 1.0.0.

## Impact

- **New:**
  - `SECURITY.md`;
  - a test that installs the packed package;
  - the fixes that the security review and the trial round call for, each with a decision where one is required.
- **Changed:**
  - `package.json`'s metadata, and its version;
  - getting started, the README, the skill, and `AGENTS.md`'s Versions, from git installs to npm;
  - the README's status.
- **For the user:** making the repository public, turning on private vulnerability reporting, and publishing to npm.
- **Runtime:** nothing changes.

## Implementation

- **Before 1.0.0**, on `release/1.0.0`:
  - The security review's findings are fixed in v0.7.0, as [Fixes from the security review](261122_011655-security-review-fixes.md) records.
  - The trial round ran on 2026-11-22, and its issues, #23 to #30, are fixed, as [the trials of the newer features](261122_005441-trials-of-the-newer-features.md#implementation) record.
  - The package: `package.json` has `keywords`, `homepage`, and `bugs`. `test/getting-started.test.ts` checks that the tarball of `bun pm pack` holds `package.json` and only what `files` names, installs it into the guide's app, which runs, tests, and type-checks with racku as installed, through `typecheckInstalled()` in `test/fixtures/typecheck.ts`, and installs racku through git at a commit as well.
  - `SECURITY.md`, and the scan of the history, before the repository went public, as [The repository is public before the first formal release](261122_062703-public-before-the-first-release.md) records. `SECURITY.md` now says which versions get fixes, as [After 1.0.0](#after-100) says.
  - CI on the commit that became 1.0.0: `check.yml` passed all four jobs, in run 45056981161, and `net-tool.yml` passed on Linux, macOS, and Windows, in run 45056986402.
- **The day of the release**, 2026-11-22:
  - `chore(release): set the package version to 1.0.0`, 5b4bcfd, went into `main`, and was tagged v1.0.0 at the user's word. CI passed on `main` as well, in run 45057636371.
  - The second step came first: the repository is public since earlier that day, as [The repository is public before the first formal release](261122_062703-public-before-the-first-release.md) records.
  - The user handed publishing to the Agent: "Go ahead, my npm access token in env var, named NPM_ACCESS_TOKEN, trial round done." npm refused every attempt, on 2026-11-22 and 2026-11-23, and nothing was published:
    - the first token had no right to publish: 403;
    - the token of an `npm login`: 403, since npm publishes only with two-factor authentication, or with a granular token that bypasses it;
    - a granular token that bypasses it: 404 on the upload, which npm answers, among other cases, when a token may not create the package. npm's answer didn't say what the token lacked.
- **Publishing waits.** On 2026-11-23 the user put it off: "The npm package won't be published for now; I don't have FIDO2 hardware." As [What can go wrong](#what-can-go-wrong) says, the tag stays, and publishing is repeated once its cause is fixed. The GitHub release comes after it, and waits with it: the tag's message, which the release takes, says that racku is on npm.
- Getting started, the README, and the skill add racku with `bun add racku valibot`, which fails until racku is on npm, and `AGENTS.md`'s Versions gives the rules from 1.0.0 on.

## Confirmation

- The user accepted this decision on 2026-11-22, with [the fixes from the security review](261122_011655-security-review-fixes.md) and [the trials of the newer features](261122_005441-trials-of-the-newer-features.md). The Agent's report had named its choices: 1.0.0 rather than a public 0.x first, publishing by the user under their npm account, and what a public history shows, the author's email and six local paths. The user's words: "All are approved. If the name rack is not already taken, rename rack42u to rack before publishing to npm."
- The name `rack` is taken. On 2026-11-22 npm's registry answered 200 for it: a package of that name since 2011, "NodeJS Cluster Abstraction Layer", at 0.1.6 and not deprecated. So the package keeps the name `rack42u`, as this decision says.
