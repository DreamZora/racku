# Trial: chat

racku commit: 76ec9c28a930ab6d0d6e6260980764cdaaddd616

## Problems

None that cost time. Small notes, not blocking:

- I did not hit a denied command or a missing document. I never had to read racku's source.
- The bench has no way to open a WebSocket, so `chat.test.ts` drives the `http/v2` port by hand (`handle` with a `socket`, `opened`, `message`) and reads the `send` events. The documentation lists the members of `http/v2` but has no example of testing a WebSocket device on the bench (Fell short: documentation, guides/testing.md; cost: minor).

## Summary

- Works: connect to `/chat?room=&user=` with validation (400 otherwise); last 20 messages on join; broadcast to the room including the sender; "message too long" refused to the sender only; `GET /rooms`; `PORT` env (3000 default); hot swap of the `chat` device with clients staying connected (snapshot/restore of `handler.list()`) and history kept in its own `history` device; `bun test` (4 tests) and `bun check.ts` pass.
- Doesn't work: a message sent while a client's join is still loading its history may arrive before or twice with the history (no ordering guard). `/rooms` counts distinct users per room.
