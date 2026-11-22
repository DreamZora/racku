# Trials of racku

This folder holds trial apps built on racku by agents that know racku only from its skill and its documentation. The problems they meet become issues of racku. You are such an agent.

## Your app

- You build one app, in its subfolder, `links/`, `chat/`, `watcher/`, `files/`, or `bot/`, as its `SPEC.md` asks.
- Work only in that subfolder. Don't look at the other apps, and don't change anything outside your subfolder.
- Another trial runs at the same time, with an app of its own: never count on a fixed port being free, and use free ports in tests and checks.

## What you know of racku

- The skill `racku`. Load it with the Skill tool: its files lie outside this folder, through a link, so reading them directly may be denied.
- Once you've added racku to your app: its documentation, in your app's `node_modules/racku/README.md` and `node_modules/racku/docs/`.
- Nothing else. When the skill and the documentation don't answer a question, you may read racku's source, in `node_modules/racku/src/`; record in `TRIAL.md` that you had to, and why.
- Don't change anything under `node_modules/`.

## Adding racku

- racku is the git repository two levels above this folder: `pwd` shows this folder's path, and the repository's path is that without `/.agents/trials`.
- Add it as the skill and the documentation say, from that repository at its current commit, in your app's folder once its `package.json` exists: `bun add git+file://<repository>#HEAD`. Run in a folder without a `package.json`, `bun add` changes the nearest one above it instead: this folder's `package.json` is there only to stop that search, so never add packages to it. Bun reports the commit it installed, as `installed racku@git+file://…#<commit>`: add racku again with that commit in place of `HEAD`, as getting started says, and write it at the top of `TRIAL.md`.

## Commands

- You may run `bun`, `bunx`, `curl`, `echo`, and commands that list or read files. Other commands are denied, and so is reading outside this folder, such as racku's own files, except the skill's.
- Keep each call simple: allowed commands, after `cd <your app's folder> &&` if need be, joined with `&&` or `;`, and piped into `grep`, `head`, or `tail`. Loops, heredocs, writing into a file with `>`, `rm`, and an environment variable before a command, such as `PORT=0 bun …`, are denied.
- A command that fails shows `Exit code <n>` at the top of its result, and a result without it means that the command exited with 0, so `$?` isn't needed; an unquoted one is denied.
- To bound how long a command runs, give the Bash tool its own timeout. To run your app while you try it, start it with the Bash tool in the background, and stop it with `TaskStop`. To give a program environment variables, start it from a script, such as with `Bun.spawn(cmd, { env: { ...process.env, PORT: "0" } })`.
- Change files with the editing tools, which create the folders they need, not with `sed` or shell redirection.
- Keep scratch files, such as a probe of how Bun behaves, in your app's `scratch/` folder, which git ignores. Don't write outside your app's folder.
- A call that is denied is a problem of the trial setup: record it in `TRIAL.md`, and go on another way. Stop only when no way is left, and say so in `TRIAL.md`.
- Never run `git`: this folder is inside racku's repository, and git commands would act on racku itself. Bun runs git by itself when it installs racku, which is fine.

## TRIAL.md

Keep `TRIAL.md` in your app's subfolder, and write each problem down when you meet it, not at the end. A problem is anything that cost you time or made you guess: documentation that was missing, wrong, or hard to find; an error message that didn't say what was wrong; an API that was hard to use, or that surprised you; a limit you ran into. Having to read racku's source is a problem too.

```markdown
# Trial: <app>

racku commit: <commit>

## Problems

### <a short title>

- Doing: what you were doing
- Happened: the command, and its output or the error
- Expected: what you expected
- Fell short: the skill, the documentation, the API, an error message, or the trial setup
- Where: the section of the skill or of the documentation, or the part of the API, and what it lacked
- Workaround: how you went on, and whether you read racku's source
- Cost: blocked, slowed, or minor

## Summary

- Works: …
- Doesn't work: …
```
