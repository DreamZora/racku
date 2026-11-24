# Decision: Apps add racku through git, at the tag of its newest version, until racku is on npm

Status: accepted

## Background

- [The first formal release](261122_005312-first-formal-release.md#the-package) has apps add racku from npm. So before 1.0.0, getting started, the README, and the skill changed to `bun add racku valibot`, and v1.0.0 is tagged with them.
- npm refused every attempt to publish 1.0.0, and on 2026-11-23 the user put publishing off, as that decision's [Implementation](261122_005312-first-formal-release.md#implementation) records. Its [What can go wrong](261122_005312-first-formal-release.md#what-can-go-wrong) keeps the tag, and leaves the steps before publishing as they are.
- So the first command of the documents fails: npm has no package named `racku`. And until racku is published, the name is free on npm: anyone who took it would have the command install their package.
- The Agent offered to point the documents to `bun add git+https://github.com/DreamZora/racku.git#v1.0.0` until racku is published, and the user accepted, as [Confirmation](#confirmation) records.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them: reliability, since the documented way to add racku must work, and must fetch racku's code and no one else's.

## Decision

### Until racku is on npm

- Getting started, the README, and the skill add racku through git, from its repository at the tag of its newest version: `bun add git+https://github.com/DreamZora/racku.git#v1.0.0 valibot`.
  - The URL is the repository's, as `package.json` names it, over HTTPS. The repository is public, so Bun's clone needs git, and no credentials.
  - The tag is `v` and the version in `package.json`. The commit that sets a new version changes the command with it, so that the documents name the newest version.
  - The README's status says that racku isn't on npm yet, and getting started names git among what an app needs.
  - To move to a newer version, an app adds racku again with its tag, as getting started says.
- What the documents say besides stays: racku follows semantic versioning, an unreleased commit comes through git, and Bun keeps a ref as typed.
- Tests hold them:
  - The test of getting started checks the command against `package.json`, and installs, in its place, the tarball of the files under test, which npm is to get. So the guide's app still runs, tests, and type-checks with the package that [Before 1.0.0](261122_005312-first-formal-release.md#before-100) checks.
  - A test installs racku through git from a repository of the files under test, at a tag and at a commit, and checks that `package.json` keeps the ref.
  - The skill gives the guide's command, which the test of getting started checks.

### Once racku is on npm

- The change that follows racku's first version on npm puts `bun add racku valibot` back into the three documents and the test, as [The package](261122_005312-first-formal-release.md#the-package) has it, and drops git from what getting started says an app needs. This decision holds only until then.

### What can go wrong

| Failure | Outcome |
|---|---|
| GitHub can't be reached, or git is missing | `bun add` fails with the error of the clone, and installs nothing. |
| A fix comes in a newer version | An app that names an older tag gets the fix once it adds racku again with the newer tag. |
| A version is tagged before the documents name it | The test of getting started fails on the commit that sets the version, so the documents change with it. |

## Alternatives

- **Leave the documents as they are**, as the release decision's [What can go wrong](261122_005312-first-formal-release.md#what-can-go-wrong) does for the steps before publishing. Their first command fails until racku is published, and could install another package if someone took the name. Not chosen.
- **Publish a placeholder to npm to hold the name.** It needs the same right to publish that npm refused. Not possible now.
- **Name no tag, and let apps choose one.** The documents would give no command that works as written. Not chosen.

## Impact

- **Changed:**
  - `docs/getting-started.md`: what an app needs, and "Add racku";
  - `README.md`: the status;
  - `skills/racku/SKILL.md`: step 1;
  - `test/getting-started.test.ts`;
  - `AGENTS.md`: Current state and Versions.
- **Releases:** while this decision holds, the commit that sets a new version changes the command's tag too.
- **Runtime and API:** nothing changes.

## Implementation

- `docs/getting-started.md`, `README.md`, and `skills/racku/SKILL.md` add racku with `bun add git+https://github.com/DreamZora/racku.git#v1.1.0 valibot`, and getting started says that an app needs git.
- `test/getting-started.test.ts`:
  - "the app of the getting-started guide installs, runs, tests, and reloads as written" checks the command against the repository and the version in `package.json`, and installs the tarball of `bun pm pack` in its place;
  - "racku installs through git from its repository at a tag or a commit, which package.json keeps" installs both, from a repository of the files under test that `repository()` tags with the version.

## Confirmation

- On 2026-11-23 the Agent's report said that the documents' `bun add racku` fails while racku isn't on npm, and that someone could take the name meanwhile. It offered a decision that points the documents to `bun add git+https://github.com/DreamZora/racku.git#v1.0.0` until racku is published. The user's answer: "Accept, go ahead, merge into main."
