import { rm } from "node:fs/promises";
import { start } from "racku";

const failures: string[] = [];
const ok = (cond: boolean, what: string) => {
  if (!cond) failures.push(what);
};

// A free port.
const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
await probe.stop(true);
process.env.PORT = String(port);

const { default: manifest } = await import("./rack.ts");
const running = await start(manifest, { baseDir: import.meta.dir, logger: () => {} });

type Client = { ws: WebSocket; got: any[]; wait: (n: number, ms?: number) => Promise<boolean>; closed: () => boolean };

function connect(room: string, user: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?room=${room}&user=${user}`);
    const got: any[] = [];
    let closed = false;
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    ws.onclose = () => (closed = true);
    ws.onerror = () => reject(new Error(`cannot connect ${room}/${user}`));
    ws.onopen = () =>
      resolve({
        ws,
        got,
        closed: () => closed,
        async wait(n, ms = 3000) {
          const end = Date.now() + ms;
          while (got.length < n && Date.now() < end) await Bun.sleep(20);
          return got.length >= n;
        },
      });
  });
}

const rooms = async () => (await fetch(`http://127.0.0.1:${port}/rooms`)).json() as Promise<{ room: string; users: number }[]>;

try {
  // 400 without a WebSocket.
  for (const q of ["room=a&user=", "room=a%20b&user=x", "user=x", `room=${"a".repeat(33)}&user=x`]) {
    const res = await fetch(`http://127.0.0.1:${port}/chat?${q}`, {
      headers: { connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    ok(res.status === 400, `bad query ${q} gives 400, got ${res.status}`);
  }

  const ann = await connect("r1", "ann");
  const bob = await connect("r1", "bob");
  const cat = await connect("r2", "cat");

  ann.ws.send("hello");
  ok(await ann.wait(1), "sender receives its own message");
  ok(await bob.wait(1), "second client receives the message");
  ok(ann.got[0]?.text === "hello" && ann.got[0]?.room === "r1" && ann.got[0]?.user === "ann" && typeof ann.got[0]?.at === "number", "message has room, user, text, at");
  bob.ws.send("yo");
  ok(await ann.wait(2) && (await bob.wait(2)), "both receive the second message");
  await Bun.sleep(200);
  ok(cat.got.length === 0, "a client in another room receives nothing");

  // Too long.
  ann.ws.send("x".repeat(1001));
  ok(await ann.wait(3), "sender gets an error for a long message");
  ok(ann.got[2]?.error === "message too long", "error says message too long");
  await Bun.sleep(200);
  ok(bob.got.length === 2 && cat.got.length === 0, "nobody else receives a refused message");
  ann.ws.send("x".repeat(1000));
  ok(await bob.wait(3), "a message of 1000 characters is accepted");
  ann.got.length = 0;
  bob.got.length = 0;

  // Late joiner.
  const dan = await connect("r1", "dan");
  ok(await dan.wait(3), "late joiner receives the recent messages");
  ok(dan.got[0]?.text === "hello" && dan.got[1]?.text === "yo", "recent messages come oldest first");

  // Rooms.
  const list = await rooms();
  ok(list.find((r) => r.room === "r1")?.users === 3 && list.find((r) => r.room === "r2")?.users === 1, `rooms lists counts: ${JSON.stringify(list)}`);

  // Swap the device that handles messages, with the clients connected.
  const next = new URL("./devices/_chat-next.ts", import.meta.url);
  const source = await Bun.file(new URL("./devices/chat.ts", import.meta.url)).text();
  await Bun.write(next, source.replace('"text only"', '"text only, please"'));
  try {
    await running.swap("chat", "./devices/_chat-next.ts");
  } catch (e) {
    failures.push(`swap failed: ${e}`);
  } finally {
    await rm(next);
  }
  ok(!ann.closed() && !bob.closed() && !cat.closed() && !dan.closed(), "clients stay connected after the swap");
  const before = dan.got.length;
  cat.ws.send("after swap");
  ok(await cat.wait(1), "chat works after the swap");
  bob.ws.send("bob after");
  ok(await dan.wait(before + 1), "chat works in the room after the swap");
  const eve = await connect("r1", "eve");
  ok(await eve.wait(4), `a client that joins after the swap receives the recent messages (got ${eve.got.length})`);
  const list2 = await rooms();
  ok(list2.find((r) => r.room === "r1")?.users === 4, `rooms still counts after the swap: ${JSON.stringify(list2)}`);

  for (const c of [ann, bob, cat, dan, eve]) c.ws.close();
} catch (e) {
  failures.push(`error: ${e}`);
} finally {
  await running.stop();
}

if (failures.length) {
  console.error("check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("check passed");
process.exit(0);
