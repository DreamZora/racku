/**
 * Tests for the example app `examples/shop-api`, run through the `rack` command line the way
 * the README describes it.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cli, ROOT, type TempApp, tempApp } from "./fixtures/app.ts";

const apps: TempApp[] = [];
const processes: Cli[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** Starts a copy of the example with the given command on a free port. */
async function shop(command: "start" | "dev") {
  const app = await tempApp(["rack.ts", "devices"], join(ROOT, "examples", "shop-api"));
  apps.push(app);
  const cli = new Cli([command, "rack.ts"], app.dir, { PORT: "0" });
  processes.push(cli);
  const url = await cli.panelUrl();
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, url), init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const post = (body: unknown) =>
    api("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, cli, api, post };
}

describe("examples/shop-api", () => {
  // Mirrors the curl session under "Try the example" in README.md.
  test("README.md: the curl walkthrough returns what the README shows", async () => {
    const { api, post } = await shop("start");
    expect((await post({ item: "book", quantity: 2, price: 12.5 })).body).toEqual({
      id: 1,
      item: "book",
      quantity: 2,
      price: 12.5,
    });
    expect((await api("/api/orders/1")).body.cached).toBe(true);
    expect((await api("/api/orders")).body).toMatchObject({ currency: "USD" });
    const stats = (await api("/api/stats")).body;
    expect(stats.served).toBe(4);
    expect(typeof stats.firmware).toBe("string");
  });

  test("creates, lists, and reads orders through the HTTP panel", async () => {
    const { app, cli, api, post } = await shop("start");
    expect(await post({ item: "book", quantity: 2, price: 12.5 })).toEqual({
      status: 201,
      body: { id: 1, item: "book", quantity: 2, price: 12.5 },
    });
    expect(await api("/api/orders/1")).toEqual({
      status: 200,
      body: { id: 1, item: "book", quantity: 2, price: 12.5, cached: true },
    });
    expect(await api("/api/orders")).toEqual({
      status: 200,
      body: { currency: "USD", orders: [{ id: 1, item: "book", quantity: 2, price: 12.5 }] },
    });
    expect((await post({ item: "", quantity: 0, price: -1 })).status).toBe(400);
    expect((await api("/api/orders/99")).status).toBe(404);
    expect(await Bun.file(join(app.dir, "data", "shop.db")).exists()).toBe(true);

    cli.kill("SIGINT");
    expect(await cli.exited()).toBe(0);
    const order = ["orders", "memkv", "sqlite"].map((name) =>
      cli.output.indexOf(`[rack] info ${name} powered off`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  test("reads an order from SQLite after the cache was emptied by a restart", async () => {
    const first = await shop("start");
    await first.post({ item: "pen", quantity: 1, price: 1 });
    first.cli.kill("SIGINT");
    expect(await first.cli.exited()).toBe(0);

    const cli = new Cli(["start", "rack.ts"], first.app.dir, { PORT: "0" });
    processes.push(cli);
    const url = await cli.panelUrl();
    const response = await fetch(new URL("/api/orders/1", url));
    expect(await response.json()).toEqual({
      id: 1,
      item: "pen",
      quantity: 1,
      price: 1,
      cached: false,
    });
  });

  test("hot-reloads the orders device in dev mode and keeps its request count", async () => {
    const { app, cli, api, post } = await shop("dev");
    await cli.waitFor(/watching /);
    await post({ item: "lamp", quantity: 1, price: 30 });
    const before = await api("/api/stats");

    const source = await app.read("devices/orders.ts");
    await app.write(
      "devices/orders.ts",
      source.replace('error: "not found"', 'error: "no such route"'),
    );
    await cli.waitFor(/\[rack\] info orders swapped/);

    const after = await api("/api/stats");
    expect(after.body.firmware).not.toBe(before.body.firmware);
    expect(after.body.served).toBe((before.body.served as number) + 1);
    expect(await api("/api/nowhere")).toEqual({ status: 404, body: { error: "no such route" } });
    expect((await api("/api/orders")).body.orders).toHaveLength(1);
    expect(cli.output).not.toMatch(/(sqlite|memkv) swapped/);
  });
});
