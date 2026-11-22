import { expect, test } from "bun:test";
import { RackError } from "racku";
import { bench, stub } from "racku/bench";
import { Commands } from "racku/std";
import { Filter } from "../connectors.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function fire(b: Awaited<ReturnType<typeof makeBot>>, method: string, path: string, body?: string) {
  const res = await b.call("http", "handle", {
    method,
    url: `http://x${path}`,
    headers: [["content-type", "application/json"]],
    params: {},
    body: body === undefined ? null : new TextEncoder().encode(body),
  });
  if (!("status" in res)) throw new Error("upgrade");
  const bytes = res.body instanceof Uint8Array ? res.body : new Uint8Array();
  return { status: res.status, json: JSON.parse(new TextDecoder().decode(bytes) || "null") };
}

function makeBot() {
  return bench(new URL("../devices/bot.ts", import.meta.url), {
    needs: {
      commands: {
        dice: stub(Commands, {
          list: () => [{ name: "roll", description: "dice", input: { type: "string" } }],
          run: ({ input }) => `rolled ${input}`,
        }),
        crashy: stub(Commands, {
          list: () => [{ name: "boom" }],
          run: () => {
            throw new Error("kaboom");
          },
        }),
        slow: stub(Commands, {
          list: () => [{ name: "stuck" }],
          run: () => new Promise(() => {}),
        }),
        picky: stub(Commands, {
          list: () => [{ name: "pick" }],
          run: () => {
            throw new RackError("BAD_ARG", "bad argument, sorry");
          },
        }),
      },
      filters: {
        words: stub(Filter, {
          check: ({ text }) => (text.includes("spam") ? { ok: false, reason: "no spam" } : { ok: true }),
        }),
        broken: stub(Filter, {
          check: () => {
            throw new Error("filter down");
          },
        }),
      },
    },
  });
}

test("the bot runs a command with the rest of the text, and lists the commands", async () => {
  await using bot = await makeBot();
  expect(await fire(bot, "POST", "/messages", JSON.stringify({ user: "a", text: "/roll 2d6" }))).toEqual({
    status: 200,
    json: { reply: "rolled 2d6" },
  });
  const list = await fire(bot, "GET", "/commands");
  expect(list.status).toBe(200);
  expect(list.json).toContainEqual({ name: "roll", plugin: "dice", description: "dice", schema: { type: "string" } });
});

test("the bot answers 404, null, 400, and 403", async () => {
  await using bot = await makeBot();
  const send = (text: unknown, user: unknown = "a") => fire(bot, "POST", "/messages", JSON.stringify({ user, text }));
  expect((await send("/nope")).status).toBe(404);
  expect((await send("hello")).json).toEqual({ reply: null });
  expect((await fire(bot, "POST", "/messages", "{bad")).status).toBe(400);
  expect((await send(3)).status).toBe(400);
  expect((await send("hi", 7)).status).toBe(400);
  const refused = await send("this is spam");
  expect(refused).toEqual({ status: 403, json: { error: "no spam" } });
  // The filter that throws is skipped, and the others still run.
  expect((await send("fine")).status).toBe(200);
});

test("a crashing command gets 500, and a plugin's own code 400", async () => {
  await using bot = await makeBot();
  const send = (text: string) => fire(bot, "POST", "/messages", JSON.stringify({ user: "a", text }));
  expect((await send("/boom x")).status).toBe(500);
  expect(await send("/pick x")).toEqual({ status: 400, json: { error: "bad argument, sorry" } });
  expect((await send("/roll 1d6")).status).toBe(200);
  expect(bot.logs.some((l) => JSON.stringify(l).includes("crashy"))).toBe(true);
});

test("a hanging command gets 504", async () => {
  await using bot = await makeBot();
  const t0 = Date.now();
  const res = await fire(bot, "POST", "/messages", JSON.stringify({ user: "a", text: "/stuck x" }));
  expect(res.status).toBe(504);
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 15_000);

void encode;
