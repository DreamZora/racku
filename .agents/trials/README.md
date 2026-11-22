# Trials

Trial apps that agents build on racku, knowing it only from its skill and its documentation, as [A skill for racku, trial apps built by independent agents, and their problems filed as GitHub issues](../decisions/261119_074252-trial-apps.md) decides. The problems they meet are filed as issues of racku.

## Running a round

1. Start Claude Code in this folder: `cd .agents/trials && claude`.
2. Ask it to run the workflow `racku-trials` with a budget of 2 million output tokens, which it passes to the workflow as args: "Run the workflow racku-trials with the args \"2M\"". The workflow doesn't start without a budget. A `+2M` directive in the request also gives one when it registers; on 2026-11-19 it didn't. The workflow runs the five apps, two at a time, links and chat, then watcher and files, then bot alone, on Sonnet 5.5, and then merges their problems into `issues.json`; `/workflows` shows its progress.
3. When it has ended, in a session at the repository's root, ask the Agent to commit the round and file its issues.

## What is here

- `CLAUDE.md`: what the trial agents are told.
- `.claude/settings.json`: leaves out racku's own `CLAUDE.md`, and allows only `bun`, `bunx`, `curl`, reading, and editing files in this folder, without prompts; every other call is denied.
- `.claude/skills/racku`: the skill, a link to the repository's `skills/racku/`.
- `.claude/workflows/racku-trials.js`: the workflow.
- `links/`, `chat/`, `watcher/`, `files/`, and `bot/`: one app each, with its `SPEC.md`, the code its trial wrote, and its `TRIAL.md`.
- `issues.json`: the problems of the last round, merged across the apps.
- `.gitignore`: what the apps install and write as they run, which git doesn't track.
