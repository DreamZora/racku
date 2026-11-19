import { start } from "rack42u";

// Start the app on a free port.
const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
await probe.stop(true);
process.env.PORT = String(port);
const { default: manifest } = await import("./rack.ts");
const running = await start(manifest, { baseDir: import.meta.dir, logger: () => {} });

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Client = { ws: WebSocket; got: any[]; closed: boolean };
async function join(room: string, user: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?room=${room}&user=${user}`);
  const client: Client = { ws, got: [], closed: false };
  ws.onmessage = (e) => client.got.push(JSON.parse(String(e.data)));
  ws.onclose = () => (client.closed = true);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot connect to ${room}`));
  });
  return client;
}
async function until(what: string, test: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await sleep(50);
  }
  failures.push(`timeout: ${what}`);
}

try {
  // Bad names get 400, without a WebSocket.
  for (const query of ["room=a", "room=a&user=", "room=a%20b&user=u", `room=${"x".repeat(33)}&user=u`]) {
    const res = await fetch(`http://127.0.0.1:${port}/chat?${query}`);
    check(res.status === 400, `400 for ${query}, got ${res.status}`);
  }

  // Two clients in one room, one in another.
  const ann = await join("r1", "ann");
  const bob = await join("r1", "bob");
  const cy = await join("r2", "cy");
  ann.ws.send("hello");
  await until("bob gets hello", () => bob.got.length >= 1);
  await until("ann gets hello", () => ann.got.length >= 1);
  bob.ws.send("hi ann");
  await until("ann gets hi", () => ann.got.length >= 2);
  await sleep(200);
  check(bob.got[0]?.text === "hello" && bob.got[0].user === "ann" && bob.got[0].room === "r1", "bob receives hello");
  check(typeof bob.got[0]?.at === "number", "message has at");
  check(ann.got.map((m) => m.text).join() === "hello,hi ann", "ann receives both messages");
  check(cy.got.length === 0, "other room receives nothing");

  // Late joiner gets recent messages.
  const dee = await join("r1", "dee");
  await until("dee gets history", () => dee.got.length >= 2);
  check(dee.got.map((m) => m.text).join() === "hello,hi ann", "late client receives recent messages, oldest first");

  // Too long.
  const before = bob.got.length;
  ann.ws.send("x".repeat(1001));
  await until("ann refused", () => ann.got.some((m) => m.error));
  await sleep(200);
  check(ann.got.some((m) => m.error === "message too long"), "sender gets the error");
  check(bob.got.length === before, "nobody else gets the long message");
  ann.ws.send("x".repeat(1000));
  await until("1000 characters go through", () => bob.got.length > before);

  // Rooms.
  const rooms: { room: string; users: number }[] = await (await fetch(`http://127.0.0.1:${port}/rooms`)).json();
  const byRoom = Object.fromEntries(rooms.map((r) => [r.room, r.users]));
  check(byRoom.r1 === 3 && byRoom.r2 === 1 && rooms.length === 2, `/rooms lists rooms: ${JSON.stringify(rooms)}`);

  // Change the device that handles messages while the clients are connected.
  await running.swap("chat", "./variants/chat-trim.ts");
  await sleep(200);
  check(![ann, bob, cy, dee].some((c) => c.closed), "clients stay connected after the swap");
  const n = dee.got.length;
  bob.ws.send("  after swap  ");
  await until("ann and dee get the message after the swap", () => ann.got.at(-1)?.text !== "x".repeat(1000) && dee.got.length > n);
  check(dee.got.at(-1)?.text === "after swap", `new device handles messages: ${JSON.stringify(dee.got.at(-1))}`);
  const eve = await join("r1", "eve");
  await until("eve gets history", () => eve.got.length >= 4);
  check(
    eve.got.map((m) => m.text).slice(-3).join("|") === `hi ann|${"x".repeat(1000)}|after swap`,
    "client that joins after the swap receives recent messages",
  );
  check(cy.got.length === 0, "other room still receives nothing");
  for (const c of [ann, bob, cy, dee, eve]) c.ws.close();
} catch (error) {
  failures.push(String(error instanceof Error ? error.stack : error));
} finally {
  await running.stop();
}

if (failures.length > 0) {
  console.error("check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("check passed");
process.exit(0);
