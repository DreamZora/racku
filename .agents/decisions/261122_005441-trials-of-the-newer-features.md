# Decision: Trials of the features since the second round: a bot whose commands are plugins, and links in one executable

Status: accepted

## Background

- [A skill for rack42u, trial apps built by independent agents, and their problems filed as GitHub issues](261119_074252-trial-apps.md#the-trial-apps) trials four apps, each reaching a part of rack42u. Its two rounds, both on 2026-11-19, found 22 issues, all of which are fixed.
- The features that came after those rounds reach no trial app:
  - `rack compile`, whose executable runs a device file from its base directory and falls back to the one packaged inside, and `--watch`, which applies such files as they change, as [single executables](261120_011627-single-executables.md) and [watching outside files](261120_221450-watching-outside-files.md) decide;
  - hot-plug directories, every needs, `commands/v1`, and the bench's stubs by device name, as [hot-plug directories](261121_065823-hot-plug-directories.md) decides.
- [The first formal release](261122_005312-first-formal-release.md#before-100) waits for a trial round on them. On 2026-11-22 the user said "OK, Go ahead" to the next trial round, among other things.
- A spec says what its app does and how to check it, and never how to use rack42u. An app reaches a feature when what it must do calls for one, and its agent finds the feature in the documentation.
- The second round began from cleared apps, in a commit of its own, `6c95899`, so that each trial built its app from its spec alone.

## Decision

### A fifth app, `bot`

| App | What it is | What it reaches |
|---|---|---|
| `bot` | A chat bot over HTTP, whose commands and filters are plugins: one file each, in a folder, that come and go while it runs | Hot-plug directories and the watch of `rack start`, every needs, `commands/v1` with JSON Schemas, plugins left out when they fail, and the bench's stubs by device name |

Its spec, `bot/SPEC.md`, asks for:

- **Messages:**
  - `POST /messages` takes the JSON body `{ "user", "text" }`.
  - A text that starts with `/` is a command: `/<name> <argument>` runs the plugin command `<name>` with the rest of the text, and answers 200 with `{ "reply" }`.
  - An unknown command gets 404. Any other text gets 200 with `{ "reply": null }`.
- **Filters:** every plugin that filters messages sees each message before it is handled. When one refuses it, the answer is 403 with `{ "error": "<the filter's reason>" }`.
- **Commands:** `GET /commands` answers with every command: its name, the plugin that offers it, its description, and the JSON Schema of its argument.
- **The first plugins**, in `plugins/`:
  - one that rolls dice, such as `/roll 2d6`;
  - one that tells the time in a time zone;
  - a filter that refuses messages with listed words.
- **Changes:** a plugin file that is added, changed, or removed while the app runs takes effect within 5 s, without a restart, and without failing requests to the other plugins.
- **Failures:** a plugin that fails to load, such as one with a syntax error, or that crashes or hangs on a command, stops neither the app nor the other plugins.
  - A command of a plugin that crashed gets 500.
  - A command that hangs gets 504 within 10 s.
  - The app's log names the plugin, and why it failed.
- **Port:** the HTTP port comes from `PORT`, 3000 by default.
- **Checks:**
  - `bun test` tests the bot's own devices with the plugins stubbed, and each plugin on its own.
  - `bun check.ts` starts the app on a free port, and goes through every behavior above. It adds, changes, breaks, and removes plugins while the app runs.

### `links`, in one executable as well

- `links/SPEC.md` asks for more: the app also builds into one executable, `dist/links`, which runs the app on its own. A new version of the device that makes codes, put beside the executable, takes the place of the one built in, while the executable runs and without a restart.
- Its check grows to match. `bun check.ts` also builds the executable, and runs it on a free port. It goes through the behaviors, then puts a code maker for 8 characters beside it. It shows that new links get codes of 8 characters, while the old links keep working.
- What links reaches grows by `rack compile`, device files beside an executable, and `--watch`.

### The round

- **Clearing:** before the round, the Agent clears each app's folder but its `SPEC.md`, in a commit of its own, as for the second round. `bot/` begins with its spec alone.
- **Order:** the workflow runs the five apps two at a time: links and chat, then watcher and files, then bot alone.
- **Budget:** 2 million output tokens covers five trials of 350,000 tokens each, and the merge of 60,000, so the budget that `README.md` names stays.
- **Files:**
  - `.gitignore` leaves out `dist/`, where links' executable goes. Bun's runtime makes the executable about 100 MB.
  - `CLAUDE.md` and `README.md` name `bot/` among the apps.
- **Commands:** what the trial agents may run stays as it is. They start the executable from a script, as they start their apps: with `Bun.spawn`.
- **Running it:** the round runs as [How the trials run](261119_074252-trial-apps.md#how-the-trials-run) says. The user starts it from a session in `.agents/trials/`, and the Agent then commits it and files its issues.

### Bounds and failures

- Five apps, with one trial agent each and at most two at a time, within the run's budget. When the rest of the budget can't cover a pair and the merge, the workflow starts no more trials, as before.
- A trial that can't build the executable, such as for lack of disk space, records that in its `TRIAL.md`, and goes on with the rest of its spec.

### Where this decision changes others

[The trial apps](261119_074252-trial-apps.md#the-trial-apps) and [Bounds and failures](261119_074252-trial-apps.md#bounds-and-failures): the four apps become five, and links reaches more. That decision stays, and this one comes first where they differ.

## Alternatives

- **A sixth app for the executable**, in place of changing links. It would keep links as it was, but a sixth trial of 350,000 tokens would take the round past 2 million tokens with the merge. Not chosen.
- **Plugins in an app that exists, such as the watcher's checkers.** The watcher already reaches `own` copies, a watchdog, and recovery from crashes. Plugins would change what it shows, and give its agent less reason to reach every needs. Not chosen.
- **The round as it is.** It would check the fixes of the second round's issues, but not the features that the release needs tried. Not chosen.

## Impact

- **In `.agents/trials/`:**
  - new: `bot/SPEC.md`;
  - changed: links' `SPEC.md`, the workflow's rounds, `CLAUDE.md`, `README.md`, and `.gitignore`;
  - the cleared apps, in a commit of their own.
- **rack42u itself:** nothing changes.
- **For the user:** starting the round from a session in `.agents/trials/`, with "Run the workflow rack42u-trials with the args \"2M\"".

## Confirmation

- The user accepted this decision on 2026-11-22, with [the first formal release](261122_005312-first-formal-release.md) and [the fixes from the security review](261122_011655-security-review-fixes.md). The user's words: "All are approved. If the name rack is not already taken, rename rack42u to rack before publishing to npm."
