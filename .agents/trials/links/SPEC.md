# links: a link shortener

Build this app on racku, in this folder. The folder's `CLAUDE.md`, one level up, says how to work here.

## What it does

An HTTP service that turns long URLs into short codes, and redirects from the codes.

- `POST /links`, with the JSON body `{ "url": "https://example.com/some/page" }`, stores the link and answers 201 with `{ "code": "…", "url": "…" }`. A code is 6 letters and digits, unique among the links.
- A body that isn't JSON, or whose `url` isn't an absolute `http:` or `https:` URL, gets 400 with the JSON body `{ "error": "<what is wrong>" }`.
- `GET /<code>` answers 302, with `Location` set to the link's URL, and counts the visit. An unknown code gets 404.
- `GET /links/<code>` answers 200 with `{ "code", "url", "visits" }`, or 404.
- The links and their visits live in SQLite, under `data/`, and survive a restart of the app.
- The HTTP port comes from the environment variable `PORT`, 3000 by default.

## How it is built

- The HTTP API, the making of codes, and the storage are separate devices, so that each can be replaced on its own.
- The device that makes codes can be changed while the app runs, such as to make codes of 8 characters instead of 6, without a restart: links made before keep working, and new links get the new codes.

## Checks

- `bun test` tests each device on its own, with what it depends on stubbed.
- `bun check.ts` starts the app on a free port, goes through every behavior above, the restart included, and stops the app. It exits with code 0, or prints what failed and exits with code 1.
- The change while the app runs: with the app running, change the device that makes codes, and show that new links get the new codes while the old links still redirect. Say in `TRIAL.md` how you checked it.

## Done

The app is done when `bun test` and `bun check.ts` pass, and the change while it runs works. Say in `TRIAL.md` whatever you couldn't finish.
