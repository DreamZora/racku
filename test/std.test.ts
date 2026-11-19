/**
 * Tests for the standard connectors and devices in `rack42u/std`.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-connectors
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-devices
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { slot } from "rack42u";
import { Kv, memkv, Sql, sqlite } from "rack42u/std";
import { describeConnector } from "../src/connector.ts";
import { buildFirmware } from "../src/firmware.ts";
import { errorOf, FIXTURES, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

describe("standard connectors", () => {
  test("kv/v1 and sql/v1 have the decided members", () => {
    expect(describeConnector(Kv)).toEqual({
      id: "kv/v1",
      members: { get: "rpc", set: "rpc", delete: "rpc", keys: "rpc", changed: "event" },
    });
    expect(describeConnector(Sql)).toEqual({
      id: "sql/v1",
      members: { query: "rpc", run: "rpc", batch: "rpc" },
    });
  });

  test("the factories return mount descriptions without loading device code", () => {
    expect(memkv().source).toBeInstanceOf(URL);
    expect(memkv({ name: "cache" }).name).toBe("cache");
    expect(sqlite({ path: "x.db" }, { name: "db" })).toMatchObject({
      name: "db",
      config: { path: "x.db" },
    });
  });

  // @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
  test("firmware keeps the rack42u/std subpath external", async () => {
    const app = await tempApp(["connectors.ts", "devices"], FIXTURES);
    apps.push(app);
    const firmware = await buildFirmware(join(app.dir, "devices/kv-watcher.ts"), app.dir);
    const code = await Bun.file(firmware.path).text();
    expect(code).toMatch(/from\s*"rack42u\/std"/);
    // A bundled copy of rack42u/std would carry the kv/v1 definition.
    expect(code).not.toContain('"kv/v1"');
  });
});

// @doc docs/guides/storage.md#memkv
describe("memkv", () => {
  async function kvRack(watcherConfig?: { throwOn: string }) {
    const { running, rec } = await startRack({
      slots: { 1: memkv(), 3: slot("./devices/kv-watcher.ts", { config: watcherConfig }) },
    });
    const kv = (method: string, input: unknown) => running.call("memkv.kv", method, input);
    return { running, rec, kv };
  }

  // @doc docs/guides/devices.md#background-work
  // Errors thrown by event handlers are logged and do not crash the device.
  test("an event handler that throws is logged and the subscriber keeps running", async () => {
    const { running, rec, kv } = await kvRack({ throwOn: "bad" });
    await kv("set", { key: "bad", value: "1" });
    await kv("set", { key: "good", value: "2" });
    await waitFor(() => rec.logs.some((e) => e.message.includes("handler failed on bad")));
    const changes = await waitFor(async () => {
      const list = (await running.call("watcher.watcher", "changes", undefined)) as string[];
      return list.length === 1 && list;
    });
    expect(changes).toEqual(["good"]);
    expect(running.status().find((s) => s.name === "watcher")?.crashes).toBe(0);
  });

  test("gets, sets, deletes, and lists keys", async () => {
    const { kv } = await kvRack();
    expect(await kv("get", "a")).toBeNull();
    await kv("set", { key: "b:2", value: "two" });
    await kv("set", { key: "a:1", value: "one" });
    await kv("set", { key: "b:1", value: "uno" });
    expect(await kv("get", "a:1")).toBe("one");
    expect(await kv("keys", "")).toEqual(["a:1", "b:1", "b:2"]);
    expect(await kv("keys", "b:")).toEqual(["b:1", "b:2"]);
    expect(await kv("delete", "a:1")).toBe(true);
    expect(await kv("delete", "a:1")).toBe(false);
    expect(await kv("get", "a:1")).toBeNull();
  });

  test("emits changed after set and after a delete that removed a key", async () => {
    const { running, kv } = await kvRack();
    await kv("set", { key: "x", value: "1" });
    await kv("delete", "x");
    await kv("delete", "missing");
    await kv("set", { key: "y", value: "2" });
    const changes = await waitFor(async () => {
      const list = (await running.call("watcher.watcher", "changes", undefined)) as string[];
      return list.length === 3 && list;
    });
    expect(changes).toEqual(["x", "x", "y"]);
  });

  test("keeps its entries across a swap", async () => {
    const { running, kv } = await kvRack();
    await kv("set", { key: "kept", value: "yes" });
    await running.swap("memkv");
    expect(await kv("get", "kept")).toBe("yes");
  });

  test("starts empty after a restart", async () => {
    const first = await kvRack();
    await first.kv("set", { key: "gone", value: "soon" });
    await first.running.stop();
    const second = await kvRack();
    expect(await second.kv("get", "gone")).toBeNull();
  });
});

// @doc docs/guides/storage.md#sqlite
describe("sqlite", () => {
  async function sqlRack(path: string, baseDir?: string) {
    const { running } = await startRack(
      { slots: { 1: sqlite({ path }) } },
      baseDir ? { baseDir } : {},
    );
    const sql = (method: string, input: unknown) => running.call("sqlite.sql", method, input);
    await sql("run", {
      sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, data BLOB)",
    });
    return { running, sql };
  }

  test("runs statements with positional parameters and returns rows as objects", async () => {
    const { sql } = await sqlRack(":memory:");
    expect(
      await sql("run", {
        sql: "INSERT INTO t (name, data) VALUES (?, ?)",
        params: ["a", new Uint8Array([1, 2])],
      }),
    ).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    await sql("run", { sql: "INSERT INTO t (name) VALUES (?)", params: ["b"] });
    const rows = (await sql("query", { sql: "SELECT id, name, data FROM t ORDER BY id" })) as {
      id: number;
      name: string;
      data: Uint8Array | null;
    }[];
    expect(rows.map((r) => [r.id, r.name])).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect([...(rows[0]?.data ?? [])]).toEqual([1, 2]);
    expect(rows[1]?.data).toBeNull();
    expect(
      await sql("query", {
        sql: "SELECT ? AS n, ? AS big, ? AS flag, ? AS empty",
        params: [1.5, 2n, true, null],
      }),
    ).toEqual([{ n: 1.5, big: 2, flag: 1, empty: null }]);
  });

  test("batch runs in one transaction and rolls back when a statement fails", async () => {
    const { sql } = await sqlRack(":memory:");
    expect(
      await sql("batch", [
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["x"] },
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["y"] },
      ]),
    ).toEqual([
      { changes: 1, lastInsertRowid: 1 },
      { changes: 1, lastInsertRowid: 2 },
    ]);
    const error = await errorOf(
      sql("batch", [
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["z"] },
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["x"] },
      ]),
    );
    expect(error.code).toBe("SQL_ERROR");
    expect(await sql("query", { sql: "SELECT name FROM t ORDER BY id" })).toEqual([
      { name: "x" },
      { name: "y" },
    ]);
  });

  // @doc docs/reference/errors.md#codes-of-the-standard-devices
  test("database errors fail with SQL_ERROR and the driver code", async () => {
    const { sql } = await sqlRack(":memory:");
    await sql("run", { sql: "INSERT INTO t (name) VALUES ('dup')" });
    const unique = await errorOf(sql("run", { sql: "INSERT INTO t (name) VALUES ('dup')" }));
    expect(unique.code).toBe("SQL_ERROR");
    expect(unique.data).toEqual({ code: "SQLITE_CONSTRAINT_UNIQUE" });
    const syntax = await errorOf(sql("query", { sql: "SELEC nonsense" }));
    expect(syntax.code).toBe("SQL_ERROR");
    expect(syntax.message).toContain("syntax error");
  });

  test("a file database is created under the base directory in WAL mode and survives a swap", async () => {
    const app = await tempApp();
    apps.push(app);
    const { running, sql } = await sqlRack("data/nested/app.db", app.dir);
    expect(await Bun.file(join(app.dir, "data/nested/app.db")).exists()).toBe(true);
    expect(await sql("query", { sql: "PRAGMA journal_mode" })).toEqual([{ journal_mode: "wal" }]);
    await sql("run", { sql: "INSERT INTO t (name) VALUES ('persisted')" });
    await running.swap("sqlite");
    expect(await sql("query", { sql: "SELECT name FROM t" })).toEqual([{ name: "persisted" }]);
  });

  test("an in-memory database moves to the new instance during a swap", async () => {
    const { running, sql } = await sqlRack(":memory:");
    await sql("run", { sql: "INSERT INTO t (name) VALUES ('moved')" });
    await running.swap("sqlite");
    expect(await sql("query", { sql: "SELECT name FROM t" })).toEqual([{ name: "moved" }]);
  });

  test("rejects a configuration without a path", async () => {
    const error = await errorOf(startRack({ slots: { 1: sqlite({ path: "" }) } }));
    expect(error.code).toBe("RACK_INVALID_CONFIG");
  });
});
