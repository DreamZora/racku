# chat: a chat room over WebSocket

Build this app on rack42u, in this folder. The folder's `CLAUDE.md`, one level up, says how to work here.

## What it does

Chat rooms, over WebSocket.

- A client connects a WebSocket to `/chat?room=<room>&user=<user>`. `room` and `user` are 1 to 32 letters, digits, `-`, or `_`; other values get 400, without a WebSocket.
- On connecting, the client receives the room's recent messages, at most the last 20, oldest first, and then every new message of the room as it comes.
- A text message from a client is a chat message: everyone in its room receives `{ "room", "user", "text", "at" }` as JSON, the sender included, where `at` is a millisecond timestamp.
- A message longer than 1000 characters is refused: its sender receives `{ "error": "message too long" }`, and nobody else receives anything.
- `GET /rooms` answers 200 with `[{ "room", "users" }]`: the rooms with at least one connected user, and how many users each has.
- The HTTP port comes from the environment variable `PORT`, 3000 by default.

## How it is built

- The handling of messages and the keeping of recent messages are separate devices.
- The device that handles messages can be changed while the app runs: the clients stay connected, they can go on chatting, and the recent messages stay.

## Checks

- `bun test` tests each device on its own, with what it depends on stubbed.
- `bun check.ts` starts the app on a free port, and shows with WebSocket clients that:
  - two clients in one room receive each other's messages, and a client in another room receives none of them;
  - a client that joins later receives the room's recent messages;
  - a message that is too long is refused;
  - `/rooms` lists the rooms;
  - after the device that handles messages is changed, with the clients connected, the clients are still connected, can still chat, and a client that joins receives the recent messages.

  It exits with code 0, or prints what failed and exits with code 1.

## Done

The app is done when `bun test` and `bun check.ts` pass. Say in `TRIAL.md` whatever you couldn't finish.
