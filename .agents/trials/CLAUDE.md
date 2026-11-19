# Trials of rack42u

This folder holds trial apps built on rack42u by agents that know rack42u only from its skill and its documentation. The problems they meet become issues of rack42u. You are such an agent.

## Your app

- You build one app, in its subfolder, `links/`, `chat/`, `watcher/`, or `files/`, as its `SPEC.md` asks.
- Work only in that subfolder. Don't look at the other apps, and don't change anything outside your subfolder.
- Another trial runs at the same time, with an app of its own: never count on a fixed port being free, and use free ports in tests and checks.

## What you know of rack42u

- The skill `rack42u`, in this folder's `.claude/skills/rack42u/`.
- Once you've added rack42u to your app: its documentation, in your app's `node_modules/rack42u/README.md` and `node_modules/rack42u/docs/`.
- Nothing else. When the skill and the documentation don't answer a question, you may read rack42u's source, in `node_modules/rack42u/src/`; record in `TRIAL.md` that you had to, and why.
- Don't change anything under `node_modules/`.

## Adding rack42u

- rack42u is the git repository two levels above this folder: `pwd` shows this folder's path, and the repository's path is that without `/.agents/trials`.
- Add it as the skill and the documentation say, from that repository at its current commit: `bun add git+file://<repository>#HEAD`. Bun reports the commit it installed, as `rack42u@git+file://…#<commit>`: pin that commit in `package.json` in place of `HEAD`, and write it at the top of `TRIAL.md`.

## Commands

- You may run `bun`, `bunx`, `curl`, and commands that list or read files. Other commands are denied.
- Never run `git`: this folder is inside rack42u's repository, and git commands would act on rack42u itself. Bun runs git by itself when it installs rack42u, which is fine.

## TRIAL.md

Keep `TRIAL.md` in your app's subfolder, and write each problem down when you meet it, not at the end. A problem is anything that cost you time or made you guess: documentation that was missing, wrong, or hard to find; an error message that didn't say what was wrong; an API that was hard to use, or that surprised you; a limit you ran into. Having to read rack42u's source is a problem too.

```markdown
# Trial: <app>

rack42u commit: <commit>

## Problems

### <a short title>

- Doing: what you were doing
- Happened: the command, and its output or the error
- Expected: what you expected
- Fell short: the skill, the documentation, the API, an error message, or the trial setup
- Where: the section of the skill or of the documentation, or the part of the API, and what it lacked
- Workaround: how you went on, and whether you read rack42u's source
- Cost: blocked, slowed, or minor

## Summary

- Works: …
- Doesn't work: …
```
