import { expect, test } from "bun:test";
import { bench, stub } from "racku/bench";
import { History, type Message } from "../connectors.ts";

type Reply = { status?: number; upgrade?: unknown; body?: Uint8Array | null };

function setup() {
  const added: Message[] = [];
  const history = stub(History, {
    add: (m) => {
      added.push(m);
    },
    recent: () => added.slice(),
  });
  return { added, history };
}

const open = (b: Awaited<ReturnType<typeof bench>>, url: string, socket: string) =>
  b.call("http", "handle", {
    method: "GET",
    url,
    headers: [
      ["connection", "upgrade"],
      ["upgrade", "websocket"],
      ["host", "localhost"],
    ],
    params: {},
    body: null,
    socket,
  }) as Promise<Reply>;

test("chat refuses a bad room or user with 400", async () => {
  const { history } = setup();
  await using chat = await bench(new URL("./chat.ts", import.meta.url), { needs: { history } });
  for (const q of ["room=a%20b&user=x", "room=a", "user=x", "room=&user=x", `room=${"a".repeat(33)}&user=x`]) {
    const reply = await open(chat, `http://localhost/chat?${q}`, "s1");
    expect(reply.status).toBe(400);
  }
  const ok = await open(chat, "http://localhost/chat?room=a&user=x", "s2");
  expect(ok.upgrade).toBeDefined();
});

test("chat sends a message to the room, refuses a long one, lists rooms", async () => {
  const { history, added } = setup();
  await using chat = await bench(new URL("./chat.ts", import.meta.url), { needs: { history } });
  await open(chat, "http://localhost/chat?room=a&user=ann", "s1");
  await open(chat, "http://localhost/chat?room=b&user=bob", "s2");
  await chat.call("http", "opened", { socket: "s1" });
  await chat.call("http", "opened", { socket: "s2" });

  await chat.call("http", "message", { socket: "s1", data: "hi" });
  await Bun.sleep(100);
  const sends = () => chat.events.filter((e) => e.event === "send").map((e) => e.payload as { socket: string[] | string; data: string });
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ room: "a", user: "ann", text: "hi" });
  expect(sends().some((e) => JSON.stringify(e.socket).includes("s1") && !JSON.stringify(e.socket).includes("s2") && JSON.parse(e.data).text === "hi")).toBe(true);

  await chat.call("http", "message", { socket: "s1", data: "x".repeat(1001) });
  await Bun.sleep(100);
  expect(added).toHaveLength(1);
  expect(sends().some((e) => JSON.parse(e.data).error === "message too long")).toBe(true);

  const rooms = (await chat.call("http", "handle", {
    method: "GET",
    url: "http://localhost/rooms",
    headers: [["host", "localhost"]],
    params: {},
    body: null,
  })) as { body: Uint8Array };
  expect(JSON.parse(new TextDecoder().decode(rooms.body))).toEqual([
    { room: "a", users: 1 },
    { room: "b", users: 1 },
  ]);
});
