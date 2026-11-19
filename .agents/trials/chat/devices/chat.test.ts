import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { History } from "../connectors.ts";

const request = (path: string, socket?: string) => ({
  method: "GET",
  url: `http://localhost${path}`,
  headers: [] as [string, string][],
  params: {},
  body: null,
  ...(socket ? { socket } : {}),
});

async function setup() {
  const added: unknown[] = [];
  const recent = [{ room: "a", user: "z", text: "old", at: 1 }];
  const device = await bench(new URL("./chat.ts", import.meta.url), {
    needs: {
      history: stub(History, {
        add(message) {
          added.push(message);
        },
        recent: () => recent,
      }),
    },
  });
  return { device, added };
}

async function sent(device: Awaited<ReturnType<typeof setup>>["device"], count: number) {
  for (let i = 0; i < 100 && device.events.filter((e) => e.event === "send").length < count; i++) {
    await Bun.sleep(20);
  }
  return device.events
    .filter((e) => e.event === "send")
    .map((e) => e.payload as { socket: string | string[]; data: string });
}

test("chat refuses bad room and user names with 400", async () => {
  const { device } = await setup();
  await using _ = device;
  for (const q of ["", "?room=a", "?room=a&user=b%20c", `?room=${"x".repeat(33)}&user=u`]) {
    const res = (await device.call("http", "handle", request(`/chat${q}`, "p:1:1"))) as { status: number };
    expect(res.status).toBe(400);
  }
});

test("chat sends recent messages on open, and broadcasts a message to its room", async () => {
  const { device, added } = await setup();
  await using _ = device;
  for (const [id, user] of [["p:1:1", "ann"], ["p:1:2", "bob"]] as const) {
    await device.call("http", "handle", request(`/chat?room=a&user=${user}`, id));
    await device.call("http", "opened", { socket: id });
  }
  await device.call("http", "handle", request("/chat?room=b&user=cy", "p:1:3"));
  await device.call("http", "opened", { socket: "p:1:3" });
  await device.call("http", "message", { socket: "p:1:1", data: "hello" });
  const events = await sent(device, 4);
  expect(events.filter((e) => e.socket === "p:1:1").map((e) => JSON.parse(e.data).text)).toContain("old");
  const broadcast = events.find((e) => JSON.parse(e.data).text === "hello")!;
  expect([broadcast.socket].flat().sort()).toEqual(["p:1:1", "p:1:2"]);
  expect(JSON.parse(broadcast.data)).toMatchObject({ room: "a", user: "ann", text: "hello" });
  expect(added).toHaveLength(1);
});

test("chat refuses a message over 1000 characters, to its sender only", async () => {
  const { device, added } = await setup();
  await using _ = device;
  await device.call("http", "handle", request("/chat?room=a&user=ann", "p:1:1"));
  await device.call("http", "opened", { socket: "p:1:1" });
  await device.call("http", "message", { socket: "p:1:1", data: "x".repeat(1001) });
  const events = await sent(device, 2);
  expect(events.map((e) => e.data)).toContain(JSON.stringify({ error: "message too long" }));
  expect(added).toHaveLength(0);
});

test("chat lists rooms and their users, and keeps its sockets through a swap", async () => {
  const { device } = await setup();
  await using _ = device;
  for (const [id, room] of [["p:1:1", "a"], ["p:1:2", "a"], ["p:1:3", "b"]] as const) {
    await device.call("http", "handle", request(`/chat?room=${room}&user=u${id.slice(-1)}`, id));
    await device.call("http", "opened", { socket: id });
  }
  await device.swap();
  const res = (await device.call("http", "handle", request("/rooms"))) as { status: number; body: Uint8Array };
  expect(res.status).toBe(200);
  const rooms = JSON.parse(new TextDecoder().decode(res.body));
  expect(rooms.sort((x: any, y: any) => x.room.localeCompare(y.room))).toEqual([
    { room: "a", users: 2 },
    { room: "b", users: 1 },
  ]);
});
