/**
 * Tests of the test bench, `rack42u/bench`: one device in a rack of its own, with stubs for its
 * needs that the tests implement.
 *
 * @decision .agents/decisions/261118_173457-device-test-bench.md#tests
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RackError, type RackHandle } from "rack42u";
import { bench, stub } from "rack42u/bench";
import { Kv } from "rack42u/std";
import { codeOf, FIXTURES, waitFor } from "./fixtures/app.ts";
import { Blobs } from "./fixtures/connectors.ts";

const ORDERS = "./devices/orders.ts";
const BENCHES = join(FIXTURES, ".rack", "bench");
const MiB = 1024 * 1024;

/** A key-value stub over a map. */
function memoryKv() {
  const store = new Map<string, string>();
  const kv = stub(Kv, {
    get: (key) => store.get(key) ?? null,
    set: ({ key, value }) => {
      store.set(key, value);
    },
  });
  return { store, kv };
}

/** A blob-store stub over a map, whose `put` reads the stream it gets. */
function memoryBlobs() {
  const files = new Map<string, Uint8Array>();
  const blobs = stub(Blobs, {
    async put({ name, bytes }) {
      const data = await Bun.readableStreamToBytes(bytes);
      files.set(name, data);
      return data.byteLength;
    },
    get(name) {
      const data = files.get(name) ?? new Uint8Array();
      return { size: data.byteLength, bytes: new Blob([data]).stream() };
    },
  });
  return { files, blobs };
}

function bytesStream(size: number): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(size).fill(7)]).stream();
}

describe("the bench", () => {
  // @doc docs/guides/testing.md#the-bench
  // @doc docs/guides/testing.md#stubs
  test("a device runs against stubs, which validate and record its calls and emit to it", async () => {
    const { store, kv } = memoryKv();
    const { blobs } = memoryBlobs();
    await using orders = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR" },
      needs: { kv, blobs },
    });
    const order = await orders.call<{ id: string }>("orders", "create", {
      item: "tea",
      quantity: 2,
    });
    expect(order).toEqual({ id: "1" });
    expect(JSON.parse(store.get("order:1") ?? "null")).toEqual({
      item: "tea",
      quantity: 2,
      currency: "EUR",
    });
    expect(orders.needs.kv.calls).toEqual([
      {
        member: "set",
        input: { key: "order:1", value: expect.any(String) },
        at: expect.any(Number),
      },
    ]);
    expect(await orders.call("orders", "find", "1")).toBe(store.get("order:1") as string);

    await kv.emit.changed({ key: "order:1" });
    await waitFor(
      async () => (await orders.call<string[]>("orders", "seen", undefined)).length > 0,
    );
    expect(await orders.call("orders", "seen", undefined)).toEqual(["order:1"]);
    expect(await codeOf(kv.emit.changed({ key: 1 } as never))).toBe("RACK_INVALID_OUTPUT");

    // The event from powerOn came before anything subscribed, so it reached no one.
    await waitFor(() => orders.events.length > 0);
    expect(orders.events).toEqual([
      { port: "orders", event: "created", payload: { id: "1" }, at: expect.any(Number) },
    ]);
    expect(orders.rack.status().map((slot) => slot.name)).toEqual([
      "stub-kv",
      "stub-blobs",
      "orders",
      "probe",
    ]);
    // A stub serves one running bench at a time.
    expect(
      await codeOf(
        bench(ORDERS, {
          baseDir: FIXTURES,
          name: "second",
          config: { currency: "EUR" },
          needs: { kv, blobs: memoryBlobs().blobs },
        }),
      ),
    ).toBe("RACK_MANIFEST");
  });

  // @doc docs/guides/testing.md#members-of-a-bench
  // @doc docs/reference/limits.md#the-bench
  test("records keep the last 10 000 entries, and count the older ones they dropped", async () => {
    const { kv } = memoryKv();
    await using orders = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR" },
      needs: { kv, blobs: memoryBlobs().blobs },
    });
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(
        Array.from({ length: 500 }, (_, index) =>
          orders.call("orders", "find", `${batch}-${index}`),
        ),
      );
    }
    await orders.call("orders", "find", "last");
    expect(kv.calls).toHaveLength(10_000);
    expect(kv.dropped).toBe(1);
    expect(kv.calls[0]?.input).toBe("order:0-1");
    expect(kv.calls.at(-1)?.input).toBe("order:last");
    expect(orders.dropped).toEqual({ events: 0, logs: 0, faults: 0 });
  });

  // @doc docs/guides/testing.md#the-bench
  test("a need without a stub, a stub of another connector, and a stub for no need fail with RACK_MANIFEST", async () => {
    const { kv } = memoryKv();
    const { blobs } = memoryBlobs();
    const missing = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR" },
      needs: { kv },
    }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(RackError);
    expect((missing as RackError).code).toBe("RACK_MANIFEST");
    expect((missing as RackError).message).toContain("blobs");

    const other = stub(Blobs, {});
    expect(
      await codeOf(
        bench(ORDERS, {
          baseDir: FIXTURES,
          config: { currency: "EUR" },
          needs: { kv: other, blobs },
        }),
      ),
    ).toBe("RACK_MANIFEST");
    expect(
      await codeOf(
        bench(ORDERS, {
          baseDir: FIXTURES,
          config: { currency: "EUR" },
          needs: { kv, blobs, cache: memoryKv().kv },
        }),
      ),
    ).toBe("RACK_MANIFEST");
    expect(existsSync(BENCHES)).toBe(false);
  });

  // @doc docs/guides/testing.md#the-bench
  test("otherwise bench() fails as start() does, for a bad configuration or a failed hook", async () => {
    const needs = { kv: memoryKv().kv, blobs: memoryBlobs().blobs };
    expect(await codeOf(bench(ORDERS, { baseDir: FIXTURES, config: {}, needs }))).toBe(
      "RACK_INVALID_CONFIG",
    );
    expect(
      await codeOf(
        bench("./devices/lifecycle.ts", { baseDir: FIXTURES, config: { failAt: "powerOn" } }),
      ),
    ).toBe("RACK_HOOK_FAILED");
    expect(existsSync(BENCHES)).toBe(false);
  });

  // @doc docs/guides/testing.md#stubs
  test("the device gets a stub's errors, bad output, and silence as a rack would give them", async () => {
    let aborted: unknown;
    const kv = stub(Kv, {
      set: () => {
        throw new RackError("RACK_LINK_DOWN", "the store is gone");
      },
      get: (key, call) => {
        if (key === "order:bad") return 42 as never;
        if (key === "order:fault") throw new Error("not a RackError");
        return new Promise<never>(() => {
          call.signal.addEventListener("abort", () => {
            aborted = call.signal.reason;
          });
        });
      },
    });
    await using orders = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR" },
      needs: { kv, blobs: memoryBlobs().blobs },
      callTimeout: 300,
    });
    const slow = { timeout: 5_000 };
    expect(await codeOf(orders.call("orders", "create", { item: "tea", quantity: 1 }, slow))).toBe(
      "RACK_LINK_DOWN",
    );
    expect(await codeOf(orders.call("orders", "find", "bad", slow))).toBe("RACK_INVALID_OUTPUT");
    expect(await codeOf(orders.call("orders", "find", "fault", slow))).toBe("RACK_DEVICE_FAULT");
    expect(await codeOf(orders.call("orders", "find", "never", slow))).toBe("RACK_TIMEOUT");
    await waitFor(() => aborted !== undefined);
    expect(aborted).toBeInstanceOf(RackError);

    // Input that the connector's schema rejects fails at the stub, which records it.
    expect(await codeOf(orders.call("orders", "put", { key: "k", value: 5 }, slow))).toBe(
      "RACK_INVALID_INPUT",
    );
    expect(kv.calls.at(-1)).toEqual({
      member: "set",
      input: { key: "k", value: 5 },
      at: expect.any(Number),
    });
    // A member that the stub doesn't implement fails as a fault of the stand-in.
    const partial = stub(Kv, {});
    await using bare = await bench(ORDERS, {
      baseDir: FIXTURES,
      name: "bare",
      config: { currency: "EUR" },
      needs: { kv: partial, blobs: memoryBlobs().blobs },
    });
    expect(await codeOf(bare.call("orders", "find", "1"))).toBe("RACK_DEVICE_FAULT");
    expect(partial.calls).toHaveLength(1);
  });

  // @doc docs/guides/testing.md#members-of-a-bench
  test("a hot swap carries the state, a restart doesn't, and a crash resets the device", async () => {
    await using orders = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR" },
      needs: { kv: memoryKv().kv, blobs: memoryBlobs().blobs },
    });
    await orders.call("orders", "create", { item: "tea", quantity: 1 });
    await orders.call("orders", "create", { item: "milk", quantity: 1 });
    await orders.swap();
    expect(await orders.call("orders", "count", undefined)).toBe(2);
    expect(orders.rack.history("orders")[0]).toMatchObject({ mode: "hot", ok: true });
    // The new instance emitted from powerOn before it was installed, so the rack dropped it.
    expect(orders.logs).toContainEqual(
      expect.objectContaining({
        device: "orders",
        level: "warn",
        message: "dropped event orders.created from an instance that is not installed",
      }),
    );
    await waitFor(() => orders.events.length === 2);
    expect(orders.events.map((recorded) => recorded.payload)).toEqual([{ id: "1" }, { id: "2" }]);
    // Nothing changed on disk, so a reload replaces nothing.
    expect(await orders.reload()).toEqual([]);

    await orders.restart();
    expect(await orders.call("orders", "count", undefined)).toBe(0);

    await orders.call("orders", "crash", undefined);
    await waitFor(() => orders.faults.length > 0);
    expect(orders.faults[0]).toMatchObject({ reset: true, error: { code: "RACK_DEVICE_FAULT" } });
    await waitFor(
      () => orders.rack.status().find((slot) => slot.name === "orders")?.state === "online",
    );
    expect(await orders.call("orders", "count", undefined)).toBe(0);
  });

  // @doc docs/guides/testing.md#members-of-a-bench
  test("a device's listener answers at the URL that status() shows", async () => {
    await using orders = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR", serve: true },
      needs: { kv: memoryKv().kv, blobs: memoryBlobs().blobs },
    });
    const slot = orders.rack.status().find((entry) => entry.name === "orders");
    const url = slot?.listeners?.[0]?.url;
    expect(url).toBeString();
    expect(await fetch(url as string).then((response) => response.text())).toBe("0 orders");
  });

  // @doc docs/guides/testing.md#stubs
  // @doc docs/reference/limits.md#the-bench
  test("streams cross a stub read whole, up to 16 MiB", async () => {
    const { files, blobs } = memoryBlobs();
    await using orders = await bench(ORDERS, {
      baseDir: FIXTURES,
      config: { currency: "EUR" },
      needs: { kv: memoryKv().kv, blobs },
    });
    expect(await orders.call("orders", "upload", { name: "a.bin", bytes: bytesStream(MiB) })).toBe(
      MiB,
    );
    expect(files.get("a.bin")?.byteLength).toBe(MiB);
    const recorded = blobs.calls[0]?.input as { name: string; bytes: Uint8Array };
    expect(recorded.name).toBe("a.bin");
    expect(recorded.bytes).toBeInstanceOf(Uint8Array);
    expect(recorded.bytes.byteLength).toBe(MiB);

    const got = await orders.call<{ size: number; bytes: ReadableStream<Uint8Array> }>(
      "orders",
      "download",
      "a.bin",
    );
    expect(got.size).toBe(MiB);
    expect((await Bun.readableStreamToBytes(got.bytes)).byteLength).toBe(MiB);

    const over = 16 * MiB + 1;
    expect(
      await codeOf(orders.call("orders", "upload", { name: "b.bin", bytes: bytesStream(over) })),
    ).toBe("RACK_INVALID_INPUT");
    files.set("big.bin", new Uint8Array(over));
    expect(await codeOf(orders.call("orders", "download", "big.bin"))).toBe("RACK_INVALID_OUTPUT");
  });

  // @doc docs/guides/testing.md#members-of-a-bench
  test("await using stops the rack and deletes the bench's files", async () => {
    let running: RackHandle | undefined;
    {
      await using orders = await bench(ORDERS, {
        baseDir: FIXTURES,
        config: { currency: "EUR" },
        needs: { kv: memoryKv().kv, blobs: memoryBlobs().blobs },
      });
      running = orders.rack;
      expect(readdirSync(BENCHES)).toHaveLength(1);
    }
    expect(running.status()).toEqual([]);
    expect(existsSync(BENCHES)).toBe(false);
  });
});
