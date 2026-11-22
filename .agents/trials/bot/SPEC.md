# bot: a chat bot whose commands are plugins

Build this app on racku, in this folder. The folder's `CLAUDE.md`, one level up, says how to work here.

## What it does

A chat bot over HTTP. Its commands and its filters come from plugins: one file each, in the folder `plugins/`, which come and go while the bot runs.

- **Messages.** `POST /messages`, with the JSON body `{ "user": "…", "text": "…" }`, gives the bot a message.
  - A text that starts with `/` is a command: `/<name> <argument>` runs the command `<name>` of the plugin that offers it, with the rest of the text as its argument, and answers 200 with `{ "reply": "…" }`.
  - An unknown command gets 404, with `{ "error": "<what is wrong>" }`.
  - Any other text gets 200 with `{ "reply": null }`.
  - A body that isn't JSON, or whose `user` or `text` isn't a string, gets 400 with `{ "error": "<what is wrong>" }`.
- **Filters.** Every plugin that filters messages sees each message before the bot handles it. When one refuses a message, the answer is 403 with `{ "error": "<the filter's reason>" }`.
- **Commands.** `GET /commands` answers 200 with every command: its name, the plugin that offers it, its description, and the JSON Schema of its argument.
- **The first plugins**, in `plugins/`:
  - one that rolls dice, such as `/roll 2d6`;
  - one that tells the time in a time zone, such as `/time Europe/Berlin`;
  - a filter that refuses the messages that hold any word of a list that it keeps.
- **Changes.** A plugin file that is added, changed, or removed while the bot runs takes effect within 5 s, without a restart, and without failing the requests to the other plugins.
- **Failures.** A plugin that fails to load, such as one with a syntax error, or that crashes or hangs on a command, stops neither the bot nor the other plugins.
  - A command of a plugin that crashed gets 500.
  - A command that hangs gets 504 within 10 s.
  - The bot's log names the plugin, and why it failed.
- The HTTP port comes from the environment variable `PORT`, 3000 by default.

## How it is built

- Each plugin is a file of its own in `plugins/`, and the bot knows none of them by name: it finds them, and what each one offers, as they come and go.

## Checks

- `bun test` tests the bot's own devices with the plugins stubbed, and each plugin on its own.
- `bun check.ts` starts the bot on a free port, and goes through every behavior above. While the bot runs, it adds, changes, breaks, and removes plugins: a plugin with a new command, a command whose reply changes, a plugin with a syntax error, one that crashes, one that hangs, and a filter that goes away. It leaves `plugins/` as it found it, and exits with code 0, or prints what failed and exits with code 1.

## Done

The app is done when `bun test` and `bun check.ts` pass. Say in `TRIAL.md` whatever you couldn't finish.
