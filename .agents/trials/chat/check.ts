import { start } from "rack42u";

// Start the app on a free port.
const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port!;
probe.stop(true);
process.env.PORT = String(port);
const { default: manifest } = await import("./rack.ts");

const failures: string[] = [];
function expect(ok: boolean, what: string) {
  if (!ok) failures.push(what);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Client = { ws: WebSocket; received: any[]; closed: boolean };

async function connect(room: string, user: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?room=${room}&user=${user}`);
  const client: Client = { ws, received: [], closed: false };
  ws.onmessage = (event) => client.received.push(JSON.parse(String(event.data)));
  ws.onclose = () => (client.closed = true);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.addEventListener("error", () => reject(new Error(`cannot connect ${room}/${user}`)));
  });
  return client;
}

async function until(test: () => boolean, what: string, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(20);
  }
  expect(false, `timed out: ${what}`);
  return false;
}

const running = await start(manifest, { baseDir: import.meta.dir, logger: () => {} });
try {
  // Invalid room or user: 400, without a WebSocket.
  for (const query of ["room=a b&user=x", "room=r&user=", "user=x", `room=${"a".repeat(33)}&user=x`]) {
    const response = await fetch(`http://127.0.0.1:${port}/chat?${query}`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(response.status === 400, `bad query "${query}" gives 400, got ${response.status}`);
  }

  // Two clients in a room, one in another.
  const ann = await connect("red", "ann");
  const bob = await connect("red", "bob");
  const cy = await connect("blue", "cy");
  ann.ws.send("hello");
  await until(() => ann.received.length === 1 && bob.received.length === 1, "both clients of red get the message");
  const message = bob.received[0];
  expect(message?.room === "red" && message?.user === "ann" && message?.text === "hello", "message fields");
  expect(typeof message?.at === "number" && Math.abs(Date.now() - message.at) < 5000, "message at is a timestamp");
  expect(ann.received[0]?.text === "hello", "the sender receives its own message");
  await sleep(150);
  expect(cy.received.length === 0, "a client in another room receives nothing");

  // A late joiner gets the recent messages.
  for (let i = 0; i < 24; i++) bob.ws.send(`m${i}`);
  await until(() => ann.received.length === 25, "ann gets 25 messages");
  const late = await connect("red", "dan");
  await until(() => late.received.length >= 20, "a late joiner gets 20 messages");
  await sleep(100);
  expect(late.received.length === 20, `late joiner gets exactly 20, got ${late.received.length}`);
  expect(late.received[0]?.text === "m4" && late.received[19]?.text === "m23", "recent messages are the last 20, oldest first");

  // Too long.
  const before = bob.received.length;
  ann.ws.send("x".repeat(1001));
  await until(() => ann.received.some((m) => m.error), "the sender gets an error");
  expect(ann.received.at(-1)?.error === "message too long", "error text");
  await sleep(150);
  expect(bob.received.length === before, "nobody else receives a refused message");
  ann.ws.send("x".repeat(1000));
  await until(() => bob.received.length === before + 1, "1000 characters are accepted");

  // /rooms
  const rooms = await (await fetch(`http://127.0.0.1:${port}/rooms`)).json();
  const sorted = [...rooms].sort((a: any, b: any) => a.room.localeCompare(b.room));
  expect(JSON.stringify(sorted) === JSON.stringify([{ room: "blue", users: 1 }, { room: "red", users: 3 }]), `/rooms lists the rooms: ${JSON.stringify(rooms)}`);

  // Change the device that handles messages, with the clients connected.
  const source = await Bun.file(new URL("./devices/chat.ts", import.meta.url)).text();
  await Bun.write(new URL("./scratch/chat-next.ts", import.meta.url), source.replace("const RECENT = 20;", "const RECENT = 20; // next version"));
  await running.swap("chat", "./scratch/chat-next.ts");
  const record = running.history("chat")[0];
  expect(record?.ok === true && record.cause === "swap", "the swap is in the history");

  const mark = ann.received.length;
  bob.ws.send("after the swap");
  await until(() => ann.received.length === mark + 1 && cy.received.length === 0, "chat goes on after the swap");
  expect(ann.received.at(-1)?.text === "after the swap", "message after swap");
  expect(![ann, bob, cy, late].some((c) => c.closed), "the clients stay connected");
  const again = await connect("red", "eve");
  await until(() => again.received.length >= 20, "a joiner after the swap gets recent messages");
  await sleep(100);
  expect(again.received.length === 20 && again.received.at(-1)?.text === "after the swap", "recent messages stay after the swap");
  const rooms2 = await (await fetch(`http://127.0.0.1:${port}/rooms`)).json();
  expect(rooms2.find((r: any) => r.room === "red")?.users === 4, `/rooms after swap: ${JSON.stringify(rooms2)}`);

  for (const c of [ann, bob, cy, late, again]) c.ws.close();
} catch (error) {
  failures.push(`error: ${error instanceof Error ? error.stack : error}`);
} finally {
  await running.stop();
}

if (failures.length > 0) {
  console.error("check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("check passed");
process.exit(0);
