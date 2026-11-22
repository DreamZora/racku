# Decision: The repository is public before the first formal release, as DreamZora/racku

Status: accepted

## Background

- [Informal versions](261119_054816-versions-and-bun.md#informal-versions) keeps the repository private until the first formal release, and [the first formal release](261122_005312-first-formal-release.md#the-day-of-the-release) makes it public on the day of the release, when the user also turns on private vulnerability reporting.
- Before that release, [Before 1.0.0](261122_005312-first-formal-release.md#before-100) asks for:
  - `SECURITY.md`, which says how to report a vulnerability privately;
  - a scan of the whole history for secrets, and the user's agreement to what the history shows of them.
- [The fixes from the security review](261122_011655-security-review-fixes.md#net-tool-and-ci) ask that the repository's settings require actions pinned by commit once it is public.
- On 2026-11-22, GitHub stopped starting jobs of Actions for the private repository, over the account's billing. The user then made the repository public, and renamed it from `DreamZora/rack42u` to `DreamZora/racku`, as [the name racku](261122_044025-the-name-racku.md#what-keeps-its-name) leaves to them. Their words:
  - "I've made the repository public; public repositories shouldn't have Actions restrictions."
  - "The GitHub repository has been renamed to racku; you need to update the remote URL."
- The Agent's report before that named what a public history shows: the author's name and email in every commit, and six local paths in the records of the trials.
- The same day, the Agent scanned the history, 196 commits, for tokens, keys, and passwords. It found none, besides the self-signed TLS keys of the tests in `test/fixtures/certs/`, which the tests' header says are public, and which nothing but the tests trusts.

## Decision

### What changes

- The repository is public from 2026-11-22, as `DreamZora/racku`.
- Versions stay informal until 1.0.0, as [Informal versions](261119_054816-versions-and-bun.md#informal-versions) says: any may break the API, and each is tagged at the user's word.
- An app of an informal version depends on racku through git, by a URL of the repository with a tag or a commit, which needs no credentials now, or by a URL of a local clone.

### What the release no longer waits for

- **The repository's visibility**, the second step of [the day of the release](261122_005312-first-formal-release.md#the-day-of-the-release).
- **Private vulnerability reporting**, which is on, and `SECURITY.md`, which says how to use it.
- **The scan of the history**, which found no secret. The user made the repository public after the report that named what the history shows.
- **Actions pinned by commit**, which the repository's settings require. Every action of the workflows is pinned so already.

### What stays for 1.0.0

The rest of [Before 1.0.0](261122_005312-first-formal-release.md#before-100) and of the day of the release: the trial round, the package's metadata and the test of its tarball, CI and `net-tool.yml`, the version and its promise, and the package on npm.

### Where this decision changes others

- [Informal versions](261119_054816-versions-and-bun.md#informal-versions): the repository is public before the first formal release.
- [The first formal release](261122_005312-first-formal-release.md): what [What the release no longer waits for](#what-the-release-no-longer-waits-for) lists is done before the tag.
- [The name racku](261122_044025-the-name-racku.md#what-keeps-its-name): the repository has the name racku too, and its URLs name it.

Each of them stays, and this decision comes first where they differ.

## Alternatives

- **Making the repository private again until 1.0.0.** CI would wait for the account's billing, and the history is public already. Not chosen: the user made it public.

## Impact

- Anyone can read the code, its history, the decisions, and the issues. A fix on a branch, such as of the security review, is visible before it merges and is tagged.
- An app can add racku from GitHub without credentials.
- Changed: the repository's URL in `package.json`, getting started, and the skill; `SECURITY.md`; `AGENTS.md`'s Versions.

## Implementation

- The repository's settings: private vulnerability reporting on, and `sha_pinning_required` for Actions, set through GitHub's API on 2026-11-22.
- `SECURITY.md`; the URL of the repository in `package.json`, `docs/getting-started.md`, `skills/racku/SKILL.md`, and `test/getting-started.test.ts`; `AGENTS.md`.

## Confirmation

- The user made the repository public, and renamed it, on 2026-11-22, with the words that [Background](#background) quotes. The Agent turned on private vulnerability reporting and the requirement of pinned actions that day, as the decisions above ask of a public repository, and recorded what changed in this decision.
