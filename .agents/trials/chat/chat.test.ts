import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Message, History } from "./connectors.ts";

const chatSource = new URL("./devices/chat.ts", import.meta.url);
const historySource = new URL("./devices/history.ts", import.meta.url);

const request = (url: string, socket?: string) => ({
  method: "GET",
  url,
  headers: socket
    ? [["connection", "Upgrade"], ["upgrade", "websocket"], ["sec-websocket-version", "13"], ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="]]
    : [],
  params: {},
  body: null,
  socket,
});

function chatBench(stored: Message[] = []) {
  return bench(chatSource, {
    needs: {
      history: stub(History, {
        add: (message) => {
          stored.push(message);
        },
        recent: () => stored,
      }),
    },
  });
}

test("chat refuses a bad room or user, and answers /rooms", async () => {
  await using chat = await chatBench();
  const bad: any = await chat.call("http", "handle", request("http://x/chat?room=a%20b&user=x", "s:1"));
  expect(bad.status).toBe(400);
  const rooms: any = await chat.call("http", "handle", request("http://x/rooms"));
  expect(rooms.status).toBe(200);
  expect(await new Response(rooms.body).json()).toEqual([]);
});

test("chat sends a message to the members of its room and keeps it", async () => {
  const stored: Message[] = [];
  await using chat = await chatBench(stored);
  for (const [id, room] of [["s:1", "red"], ["s:2", "red"], ["s:3", "blue"]] as const) {
    const upgrade: any = await chat.call("http", "handle", request(`http://x/chat?room=${room}&user=u${id.slice(2)}`, id));
    expect(upgrade.upgrade).toBeDefined();
    await chat.call("http", "opened", { socket: id });
  }
  await chat.call("http", "message", { socket: "s:1", data: "hi" });
  expect(stored).toHaveLength(1);
  const sent = chat.events.filter((e) => e.event === "send").map((e) => e.payload as any);
  await Bun.sleep(50);
  const events = chat.events.filter((e) => e.event === "send").map((e) => e.payload as any);
  expect(events.length).toBeGreaterThan(sent.length - 1);
  const last = events.at(-1);
  expect(last.socket.sort()).toEqual(["s:1", "s:2"]);
  expect(JSON.parse(last.data)).toMatchObject({ room: "red", user: "u1", text: "hi" });
  const rooms: any = await chat.call("http", "handle", request("http://x/rooms"));
  const list = (await new Response(rooms.body).json()).sort((a: any, b: any) => a.room.localeCompare(b.room));
  expect(list).toEqual([{ room: "blue", users: 1 }, { room: "red", users: 2 }]);
});

test("chat refuses a message that is too long to its sender only", async () => {
  const stored: Message[] = [];
  await using chat = await chatBench(stored);
  await chat.call("http", "handle", request("http://x/chat?room=r&user=u", "s:1"));
  await chat.call("http", "opened", { socket: "s:1" });
  await chat.call("http", "message", { socket: "s:1", data: "x".repeat(1001) });
  await Bun.sleep(50);
  expect(stored).toHaveLength(0);
  const sends = chat.events.filter((e) => e.event === "send").map((e) => e.payload as any);
  expect(sends).toHaveLength(1);
  expect(sends[0].socket).toEqual("s:1");
  expect(JSON.parse(sends[0].data)).toEqual({ error: "message too long" });
});

test("history keeps the last 20 messages of a room, also through a swap", async () => {
  await using history = await bench(historySource, { needs: {} });
  for (let i = 0; i < 25; i++) await history.call("history", "add", { room: "r", user: "u", text: `m${i}`, at: i });
  await history.call("history", "add", { room: "other", user: "u", text: "o", at: 1 });
  await history.swap();
  const recent: any = await history.call("history", "recent", { room: "r", limit: 20 });
  expect(recent).toHaveLength(20);
  expect(recent[0].text).toBe("m5");
  expect(recent[19].text).toBe("m24");
  expect(await history.call("history", "recent", { room: "r", limit: 3 })).toHaveLength(3);
  expect(await history.call("history", "recent", { room: "none", limit: 20 })).toEqual([]);
});
