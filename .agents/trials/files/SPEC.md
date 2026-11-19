# files: a file store

Build this app on rack42u, in this folder. The folder's `CLAUDE.md`, one level up, says how to work here.

## What it does

An HTTP service that stores files.

- `PUT /files/<name>` stores the request's body as the file `<name>`, and answers 201 with `{ "name", "size", "sha256" }`. A file that exists is replaced.
- `GET /files/<name>` answers the file's bytes, with its `Content-Length`. An unknown name gets 404.
- `GET /files` answers `[{ "name", "size", "sha256" }]`, sorted by name. `DELETE /files/<name>` answers 204, or 404.
- A name is 1 to 100 letters, digits, `.`, `-`, or `_`, and doesn't start with `.`; other names get 400.
- A file can have up to 50 MiB. A larger upload gets 413, and leaves no file behind.
- The files live under `data/files/`, and survive a restart of the app.
- The HTTP port comes from the environment variable `PORT`, 3000 by default.

## How it is built

- Uploads and downloads stream: no part of the app holds a whole file of 50 MiB in memory at once.
- The device that writes the files must never run twice at once, not even while its code is being changed, since two writers could break a file.
- Every device can be changed while the app runs.

## Checks

- `bun test` tests each device on its own, with what it depends on stubbed.
- `bun check.ts` starts the app on a free port, and shows that:
  - files of 1 KiB, 10 MiB, and 50 MiB upload, and download with the same size and hash;
  - an upload of more than 50 MiB gets 413, and leaves no file;
  - the list, the deletion, and the names that get 400 work as above;
  - after a restart of the app, the files are still there;
  - after the device that writes files is changed while the app runs, it still stores and serves them.

  It exits with code 0, or prints what failed and exits with code 1.

## Done

The app is done when `bun test` and `bun check.ts` pass. Say in `TRIAL.md` whatever you couldn't finish.
