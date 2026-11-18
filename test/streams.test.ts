/**
 * Tests for byte streams in calls: between devices on links, and through `rack.call()` on the
 * data channel.
 *
 * @decision .agents/decisions/261118_071155-backplane-streams.md#streams-in-calls
 * @decision .agents/decisions/261118_071155-backplane-streams.md#transport
 * @decision .agents/decisions/261118_071155-backplane-streams.md#flow-control
 * @decision .agents/decisions/261118_071155-backplane-streams.md#timeouts
 * @decision .agents/decisions/261118_071155-backplane-streams.md#cancellation-and-errors
 * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
 * @decision .agents/decisions/261118_071155-backplane-streams.md#observation
 */
import { describe, expect, test } from "bun:test";
import {
  type CalledRpcMetrics,
  RackError,
  type RackHandle,
  type ServedRpcMetrics,
  slot,
} from "rack42u";
import { codeOf, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const RACK = {
  slots: { 1: slot("./devices/streamer.ts"), 3: slot("./devices/stream-client.ts") },
};

const KiB = 1024;
const MiB = 1024 * KiB;
/** The credit a receiving end grants, as the streams decision sets it. */
const WINDOW = 256 * KiB;

interface Report {
  firmware: string;
  produced: number;
  cancelled: string[];
  detached: number;
  consumeErrors: string[];
}

interface Read {
  ok: boolean;
  code: string | null;
  total: number;
  chunks: number;
  largest: number;
}

const report = (running: RackHandle) =>
  running.call("streamer.streams", "report", undefined) as Promise<Report>;

const produce = (running: RackHandle, args: Record<string, unknown>, options = {}) =>
  running.call("streamer.streams", "produce", args, options) as Promise<{
    size: number;
    bytes: ReadableStream<Uint8Array>;
  }>;

const client = (running: RackHandle, member: string, input: unknown) =>
  running.call("stream-client.client", member, input);

/** Reads a stream to its end and reports what came, or the code it failed with. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
  options: { delay?: number; cancelAt?: number } = {},
): Promise<{ sizes: number[]; bytes: number[]; code: string | null }> {
  const reader = stream.getReader();
  const sizes: number[] = [];
  const bytes: number[] = [];
  try {
    for (;;) {
      if (options.cancelAt !== undefined && sizes.length >= options.cancelAt) {
        await reader.cancel();
        return { sizes, bytes, code: null };
      }
      if (options.delay) await Bun.sleep(options.delay);
      const { done, value } = await reader.read();
      if (done) return { sizes, bytes, code: null };
      sizes.push(value.byteLength);
      bytes.push(value[0] as number);
    }
  } catch (error) {
    return { sizes, bytes, code: error instanceof RackError ? error.code : String(error) };
  }
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** A source in the test process that makes each chunk only when read, and records its end. */
function source(
  size: number,
  chunk: number,
  options: { delay?: number; stallAt?: number; fail?: unknown; junk?: boolean } = {},
) {
  const seen = { pulled: 0, cancelled: null as string | null };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (options.delay) await Bun.sleep(options.delay);
        if (options.stallAt !== undefined && index >= options.stallAt) {
          await new Promise(() => {});
        }
        if (options.junk) {
          controller.enqueue("not bytes" as unknown as Uint8Array);
          return;
        }
        if (options.fail !== undefined && index === 1) {
          controller.error(options.fail);
          return;
        }
        if (seen.pulled >= size) {
          controller.close();
          return;
        }
        const length = Math.min(chunk, size - seen.pulled);
        controller.enqueue(new Uint8Array(length).fill(1));
        seen.pulled += length;
        index++;
      },
      cancel(reason) {
        seen.cancelled = reason instanceof RackError ? reason.code : String(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

const consume = (running: RackHandle, input: Record<string, unknown>, options = {}) =>
  running.call("streamer.streams", "consume", input, options) as Promise<{
    total: number;
    chunks: number;
    largest: number;
    sum: number;
    deadline: number;
    error: string | null;
  }>;

async function deviceMetrics(running: RackHandle, device: string) {
  const metrics = await running.metrics();
  const entry = metrics.devices.find((d) => d.device === device);
  if (entry === undefined) throw new Error(`no metrics for ${device}`);
  return entry;
}

describe("streams in calls", () => {
  // README.md, "Streams": a request body streams to a device and a response body streams back.
  test("README.md: rack.call() streams an input to a device, and a result back", async () => {
    const { running } = await startRack(RACK);
    const upload = new Blob([new Uint8Array(3 * MiB).fill(2)]).stream();
    const consumed = await consume(running, { bytes: upload });
    expect([consumed.total, consumed.sum]).toEqual([3 * MiB, 6 * MiB]);
    const { bytes } = await produce(running, { size: 5 * MiB, chunk: 64 * KiB, fill: 7 });
    const read = await readAll(bytes);
    expect([sum(read.sizes), read.code, new Set(read.bytes)]).toEqual([
      5 * MiB,
      null,
      new Set([7]),
    ]);
    const echoed = await running.call(
      "streamer.streams",
      "echo",
      new Blob([new Uint8Array(MiB).fill(4)]).stream(),
    );
    expect(sum((await readAll(echoed as ReadableStream<Uint8Array>)).sizes)).toBe(MiB);
  });

  test("README.md: a connector of another schema library declares a stream as a ReadableStream instance", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/zod-counter.ts") } });
    const bytes = new Blob([new Uint8Array(2 * MiB)]).stream();
    expect(await running.call("zod-counter.zod", "count", { bytes })).toBe(2 * MiB);
  });

  test("README.md: a call between devices streams its input, and its result streams back", async () => {
    const { running } = await startRack(RACK);
    const id = await client(running, "upload", { size: 2 * MiB, chunk: 100 * KiB });
    expect(await client(running, "finished", id)).toEqual({
      ok: true,
      code: null,
      total: 2 * MiB,
      // A provider sees no deadline for a call with an input stream.
      deadline: Number.POSITIVE_INFINITY,
      cancelled: null,
    });
    const opened = await client(running, "open", { args: { size: 5 * MiB, chunk: 64 * KiB } });
    expect(await client(running, "read", { id: opened })).toEqual({
      ok: true,
      code: null,
      total: 5 * MiB,
      chunks: 80,
      largest: 64 * KiB,
    });
  });

  test("README.md: a slow reader slows the source, with at most the window in flight", async () => {
    const { running } = await startRack(RACK);
    const chunk = 64 * KiB;
    const { bytes } = await produce(running, { size: 16 * MiB, chunk });
    const reader = bytes.getReader();
    let taken = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) {
        const { value } = await reader.read();
        taken += value?.byteLength ?? 0;
      }
      await Bun.sleep(150);
      const { produced } = await report(running);
      expect(produced).toBeGreaterThan(taken);
      expect(produced - taken).toBeLessThanOrEqual(WINDOW + chunk);
    }
    await reader.cancel();
    // Between devices: a consumer that doesn't read lets its provider send the window only.
    const before = (await report(running)).produced;
    const opened = await client(running, "open", { args: { size: 16 * MiB, chunk } });
    await Bun.sleep(200);
    expect((await report(running)).produced - before).toBeLessThanOrEqual(WINDOW + chunk);
    const read = (await client(running, "read", { id: opened })) as Read;
    expect([read.code, read.total]).toEqual([null, 16 * MiB]);
  });

  test("a chunk over 1 MiB arrives in pieces of at most 1 MiB, and sources keep their buffers", async () => {
    const { running } = await startRack(RACK);
    const big = await produce(running, { size: 3.5 * MiB, chunk: 3.5 * MiB });
    expect((await readAll(big.bytes)).sizes).toEqual([MiB, MiB, MiB, 0.5 * MiB]);
    // The source writes into one buffer for every chunk; each chunk arrives as it was sent.
    const reused = await produce(running, {
      size: 4 * 64 * KiB,
      chunk: 64 * KiB,
      fill: 10,
      reuse: true,
    });
    expect((await readAll(reused.bytes)).bytes).toEqual([10, 11, 12, 13]);
    expect((await report(running)).detached).toBe(0);
    // A source in the caller keeps its buffer too.
    const shared = new Uint8Array(64 * KiB);
    let round = 0;
    const upload = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (round === 2) {
            controller.close();
            return;
          }
          round++;
          shared.fill(round);
          controller.enqueue(shared);
        },
      },
      { highWaterMark: 0 },
    );
    const consumed = await consume(running, { bytes: upload });
    expect([consumed.total, consumed.sum, shared.buffer.detached]).toEqual([
      128 * KiB,
      64 * KiB * 3,
      false,
    ]);
  });

  test("a reader that cancels cancels the source with RACK_CANCELLED", async () => {
    const { running } = await startRack(RACK);
    const { bytes } = await produce(running, { size: 8 * MiB, chunk: 64 * KiB });
    await readAll(bytes, { cancelAt: 2 });
    await waitFor(async () => (await report(running)).cancelled.includes("RACK_CANCELLED"));
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    const read = (await client(running, "read", { id: opened, cancelAt: 3 })) as Read;
    expect([read.code, read.chunks]).toEqual([null, 3]);
    await waitFor(
      async () =>
        (await report(running)).cancelled.filter((c) => c === "RACK_CANCELLED").length === 2,
    );
  });

  test("README.md: the call's signal cancels its streams, also after the result has arrived", async () => {
    const { running } = await startRack(RACK);
    const controller = new AbortController();
    const { bytes } = await produce(
      running,
      { size: 8 * MiB, chunk: 64 * KiB },
      { signal: controller.signal },
    );
    const reader = bytes.getReader();
    await reader.read();
    controller.abort();
    expect(await codeOf(reader.read())).toBe("RACK_CANCELLED");
    await waitFor(async () => (await report(running)).cancelled.includes("RACK_CANCELLED"));
  });

  test("a source that fails errors the reader's stream with the source's code", async () => {
    const { running } = await startRack(RACK);
    const { bytes } = await produce(running, { size: MiB, chunk: 64 * KiB, failAt: 2 });
    expect(await readAll(bytes)).toMatchObject({
      sizes: [64 * KiB, 64 * KiB],
      code: "SOURCE_FAILED",
    });
    const opened = await client(running, "open", {
      args: { size: MiB, chunk: 64 * KiB, failAt: 1 },
    });
    expect(await client(running, "read", { id: opened })).toMatchObject({ code: "SOURCE_FAILED" });
    // A RackError keeps its code; any other error becomes RACK_DEVICE_FAULT.
    const coded = source(MiB, 64 * KiB, { fail: new RackError("UPLOAD_FAILED", "on purpose") });
    expect((await consume(running, { bytes: coded.stream })).error).toBe("UPLOAD_FAILED");
    const plain = source(MiB, 64 * KiB, { fail: new Error("on purpose") });
    expect((await consume(running, { bytes: plain.stream })).error).toBe("RACK_DEVICE_FAULT");
  });

  test("a chunk that isn't bytes fails the stream at both ends", async () => {
    const { running } = await startRack(RACK);
    const { bytes } = await produce(running, { size: MiB, chunk: 64 * KiB, junk: true });
    expect((await readAll(bytes)).code).toBe("RACK_INVALID_OUTPUT");
    await waitFor(async () => (await report(running)).cancelled.includes("RACK_INVALID_OUTPUT"));
    const junk = source(MiB, 64 * KiB, { junk: true });
    expect((await consume(running, { bytes: junk.stream })).error).toBe("RACK_INVALID_INPUT");
    expect(junk.seen.cancelled).toBe("RACK_INVALID_INPUT");
  });

  test("README.md: a stream that moves nothing for streamTimeout fails with RACK_TIMEOUT at both ends", async () => {
    const { running } = await startRack(RACK);
    const stalled = await produce(
      running,
      { size: MiB, chunk: 64 * KiB, stall: true },
      { streamTimeout: 200 },
    );
    expect(await readAll(stalled.bytes)).toMatchObject({ sizes: [64 * KiB], code: "RACK_TIMEOUT" });
    await waitFor(async () => (await report(running)).cancelled.includes("RACK_TIMEOUT"));
    const upload = source(MiB, 64 * KiB, { stallAt: 1 });
    const consumed = await consume(running, { bytes: upload.stream }, { streamTimeout: 200 });
    expect([consumed.error, upload.seen.cancelled]).toEqual(["RACK_TIMEOUT", "RACK_TIMEOUT"]);
    // By default a stream idles as long as its call may take.
    const started = performance.now();
    const quiet = await produce(
      running,
      { size: MiB, chunk: 64 * KiB, stall: true },
      { timeout: 300 },
    );
    expect((await readAll(quiet.bytes)).code).toBe("RACK_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(2_000);
    // A reader that never reads holds its window until the timeout.
    const opened = await client(running, "open", {
      args: { size: 8 * MiB, chunk: 64 * KiB },
      streamTimeout: 200,
    });
    await Bun.sleep(400);
    expect(await client(running, "read", { id: opened })).toMatchObject({ code: "RACK_TIMEOUT" });
  });

  test("README.md: a call with an input stream times out from the end of that stream", async () => {
    const { running } = await startRack(RACK);
    // 10 chunks 60 ms apart take longer than the timeout, which runs once they have all gone.
    const slow = await client(running, "upload", {
      size: 10 * 64 * KiB,
      chunk: 64 * KiB,
      sourceDelay: 60,
      timeout: 200,
    });
    expect(await client(running, "finished", slow)).toMatchObject({ ok: true, total: 640 * KiB });
    const late = await client(running, "upload", {
      size: 64 * KiB,
      chunk: 64 * KiB,
      after: 600,
      timeout: 200,
    });
    expect(await client(running, "finished", late)).toMatchObject({
      ok: false,
      code: "RACK_TIMEOUT",
    });
    const upload = source(10 * 64 * KiB, 64 * KiB, { delay: 60 });
    expect((await consume(running, { bytes: upload.stream }, { timeout: 200 })).total).toBe(
      640 * KiB,
    );
    const quick = source(64 * KiB, 64 * KiB);
    const timedOut = consume(running, { bytes: quick.stream, after: 600 }, { timeout: 200 });
    expect(await codeOf(timedOut)).toBe("RACK_TIMEOUT");
  });

  test("a provider that returns early cancels the rest of its input, and one that pipes it streams all of it", async () => {
    const { running } = await startRack(RACK);
    const upload = source(MiB, 64 * KiB);
    const consumed = await consume(running, { bytes: upload.stream, take: 1 });
    expect(consumed.total).toBe(64 * KiB);
    await waitFor(() => upload.seen.cancelled === "RACK_CANCELLED");
    expect(upload.seen.pulled).toBeLessThan(MiB);
    const piped = source(2 * MiB, 64 * KiB);
    const echoed = (await running.call(
      "streamer.streams",
      "echo",
      piped.stream,
    )) as ReadableStream<Uint8Array>;
    const read = await readAll(echoed);
    expect([sum(read.sizes), piped.seen.cancelled]).toEqual([2 * MiB, null]);
    // A reader that cancels the output cancels the input that it reads.
    const cancelled = source(8 * MiB, 64 * KiB);
    const again = (await running.call(
      "streamer.streams",
      "echo",
      cancelled.stream,
    )) as ReadableStream<Uint8Array>;
    await readAll(again, { cancelAt: 2 });
    await waitFor(() => cancelled.seen.cancelled === "RACK_CANCELLED");
  });

  test("a call that fails before its provider reads its input cancels the stream at its source", async () => {
    const { running } = await startRack(RACK, { queueLimit: 1 });
    const invalid = source(MiB, 64 * KiB);
    const failed = consume(running, { bytes: invalid.stream, take: "all" });
    expect(await codeOf(failed)).toBe("RACK_INVALID_INPUT");
    await waitFor(() => invalid.seen.cancelled === "RACK_CANCELLED");
    const unknown = source(MiB, 64 * KiB);
    const unrouted = running.call("nobody.streams", "consume", { bytes: unknown.stream });
    expect(await codeOf(unrouted)).toBe("RACK_NO_ROUTE");
    expect(unknown.seen.cancelled).toBe("RACK_CANCELLED");
    // With queueLimit 1, a call that waits keeps the next one out.
    const slow = source(MiB, 64 * KiB, { delay: 100 });
    const first = consume(running, { bytes: slow.stream });
    const over = source(MiB, 64 * KiB);
    expect(await codeOf(consume(running, { bytes: over.stream }))).toBe("RACK_OVERLOADED");
    expect(over.seen.cancelled).toBe("RACK_CANCELLED");
    expect((await first).total).toBe(MiB);
    await running.stop();
    const down = source(MiB, 64 * KiB);
    expect(await codeOf(consume(running, { bytes: down.stream }))).toBe("RACK_LINK_DOWN");
    expect(down.seen.cancelled).toBe("RACK_CANCELLED");
  });

  test("streams nested deeper, two in one direction, and streams in events fail as values that can't be cloned", async () => {
    const { running } = await startRack(RACK);
    const one = source(MiB, 64 * KiB);
    const two = source(MiB, 64 * KiB);
    const both = consume(running, { bytes: one.stream, other: two.stream });
    expect(await codeOf(both)).toBe("RACK_INVALID_INPUT");
    expect([one.seen.cancelled, two.seen.cancelled]).toEqual(["RACK_CANCELLED", "RACK_CANCELLED"]);
    const nested = source(MiB, 64 * KiB);
    expect(await codeOf(consume(running, { bytes: { inner: nested.stream } }))).toBe(
      "RACK_INVALID_INPUT",
    );
    expect(await codeOf(running.call("streamer.streams", "bad", "two"))).toBe(
      "RACK_INVALID_OUTPUT",
    );
    await waitFor(
      async () =>
        (await report(running)).cancelled.filter((c) => c === "RACK_CANCELLED").length === 2,
    );
    expect(await codeOf(running.call("streamer.streams", "bad", "nested"))).toBe(
      "RACK_INVALID_OUTPUT",
    );
    expect(await codeOf(running.call("streamer.streams", "publish", undefined))).toBe(
      "RACK_INVALID_OUTPUT",
    );
  });

  test("README.md: the streams counters, and active and pending while a stream is open", async () => {
    const { running } = await startRack(RACK);
    const opened = await client(running, "open", { args: { size: MiB, chunk: 64 * KiB } });
    await Bun.sleep(100);
    const called = () =>
      deviceMetrics(running, "stream-client").then(
        (m) => m.needs.streams?.produce as CalledRpcMetrics,
      );
    const servedOf = () =>
      deviceMetrics(running, "streamer").then(
        (m) => m.provides.streams?.produce as ServedRpcMetrics,
      );
    expect(await called()).toMatchObject({
      calls: 1,
      ok: 1,
      pending: 1,
      streams: { opened: 1, open: 1 },
    });
    expect(await servedOf()).toMatchObject({
      calls: 1,
      ok: 1,
      active: 1,
      streams: { opened: 1, open: 1 },
    });
    // The call has its result, so status() counts it no more, and a drain wouldn't wait for it.
    expect(running.status().find((s) => s.name === "streamer")?.inFlight).toBe(0);
    await client(running, "read", { id: opened, cancelAt: 4 });
    await waitFor(async () => (await servedOf()).active === 0);
    const after = await called();
    expect(after).toMatchObject({
      pending: 0,
      streams: { opened: 1, open: 0, bytesSent: 0, errors: { RACK_CANCELLED: 1 } },
    });
    // The pieces that arrived count, taken or not: at most the window more than were taken.
    expect(after.streams?.bytesReceived).toBeGreaterThanOrEqual(4 * 64 * KiB);
    expect(after.streams?.bytesReceived).toBeLessThanOrEqual(4 * 64 * KiB + WINDOW);
    const served = await servedOf();
    expect(served.streams).toMatchObject({
      opened: 1,
      open: 0,
      bytesReceived: 0,
      errors: { RACK_CANCELLED: 1 },
    });
    // What it sent: the pieces taken, and at most the window more.
    expect(served.streams?.bytesSent).toBeGreaterThanOrEqual(4 * 64 * KiB);
    expect(served.streams?.bytesSent).toBeLessThanOrEqual(4 * 64 * KiB + WINDOW);
    // Calls from outside the rack count their streams too.
    const { bytes } = await produce(running, { size: MiB, chunk: 64 * KiB });
    const outside = () =>
      running.metrics().then((m) => m.outside.ports["streamer.streams"]?.produce);
    expect(await outside()).toMatchObject({ pending: 1, streams: { opened: 1, open: 1 } });
    await readAll(bytes);
    expect(await outside()).toMatchObject({
      pending: 0,
      streams: { opened: 1, open: 0, bytesReceived: MiB, bytesSent: 0 },
    });
  });
});

describe("streams through swaps, faults, and holds", () => {
  test("a call held during a swap reads nothing of its input stream until it goes out", async () => {
    const { running, rec } = await startRack(RACK);
    await running.call("streamer.streams", "slowSnapshot", 600);
    const swapped = running.swap("streamer");
    await waitFor(() => rec.logs.some((e) => e.message === "hook" && e.device === "streamer"));
    const id = await client(running, "upload", { size: MiB, chunk: 64 * KiB });
    await waitFor(async () => {
      const metrics = await deviceMetrics(running, "stream-client");
      return (metrics.needs.streams?.consume as CalledRpcMetrics | undefined)?.queued === 1;
    });
    expect(await client(running, "pulled", id)).toBe(0);
    await swapped;
    expect(await client(running, "finished", id)).toMatchObject({ ok: true, total: MiB });
  });

  test("a retiring instance's open streams fail with RACK_LINK_DOWN at the end of its drain", async () => {
    const { running } = await startRack(RACK, { drainTimeout: 300 });
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    const { bytes } = await produce(running, { size: 8 * MiB, chunk: 64 * KiB });
    const started = performance.now();
    await running.swap("streamer");
    // The retirement waited for the open streams, as long as its drain may last.
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(await client(running, "read", { id: opened })).toMatchObject({ code: "RACK_LINK_DOWN" });
    expect((await readAll(bytes)).code).toBe("RACK_LINK_DOWN");
  });

  test("a stream that ends while its instance retires ends normally", async () => {
    const { running } = await startRack(RACK, { drainTimeout: 3_000 });
    const opened = await client(running, "open", { args: { size: 2 * MiB, chunk: 64 * KiB } });
    await Bun.sleep(50);
    const swapped = running.swap("streamer");
    await Bun.sleep(200);
    const read = client(running, "read", { id: opened });
    await swapped;
    expect(await read).toMatchObject({ code: null, total: 2 * MiB });
  });

  test("a state handover isn't held by an open stream", async () => {
    const { running } = await startRack(RACK, { drainTimeout: 2_000 });
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    await Bun.sleep(100);
    const started = performance.now();
    const swapped = running.swap("streamer");
    // A new instance has made nothing yet: it is installed while the old stream is still open.
    await waitFor(async () => (await report(running)).produced === 0, 1_500);
    expect(performance.now() - started).toBeLessThan(1_500);
    await swapped;
    expect(await client(running, "read", { id: opened })).toMatchObject({ code: "RACK_LINK_DOWN" });
  });

  test("a restart cuts the open streams once the calls have returned", async () => {
    const { running } = await startRack(RACK, { drainTimeout: 5_000 });
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    await Bun.sleep(100);
    const started = performance.now();
    await running.restart("streamer", { cascade: false });
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(await client(running, "read", { id: opened })).toMatchObject({ code: "RACK_LINK_DOWN" });
  });

  test("README.md: a cold swap cuts the open streams once the calls have returned", async () => {
    const { running } = await startRack(
      { slots: { 1: slot("./devices/streamer-cold.ts"), 3: slot("./devices/stream-client.ts") } },
      { drainTimeout: 5_000 },
    );
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    await Bun.sleep(100);
    const started = performance.now();
    await running.swap("streamer");
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(await client(running, "read", { id: opened })).toMatchObject({ code: "RACK_LINK_DOWN" });
  });

  test("a provider that crashes fails its open streams with RACK_DEVICE_FAULT", async () => {
    const { running, rec } = await startRack(RACK);
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    const { bytes } = await produce(running, { size: 8 * MiB, chunk: 64 * KiB });
    const upload = await client(running, "upload", { size: 8 * MiB, chunk: 64 * KiB, delay: 50 });
    await Bun.sleep(100);
    await running.call("streamer.streams", "crash", undefined);
    // The Worker exits 10 ms after it answers; reading sooner could finish first.
    await waitFor(() => rec.logs.some((e) => e.message.startsWith("streamer crashed")));
    expect(await client(running, "read", { id: opened })).toMatchObject({
      code: "RACK_DEVICE_FAULT",
    });
    expect((await readAll(bytes)).code).toBe("RACK_DEVICE_FAULT");
    expect(await client(running, "finished", upload)).toMatchObject({
      ok: false,
      code: "RACK_DEVICE_FAULT",
      cancelled: "RACK_DEVICE_FAULT",
    });
  });

  test("a consumer that crashes cancels the streams of its calls with RACK_DEVICE_FAULT", async () => {
    const { running } = await startRack(RACK);
    await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    await client(running, "upload", { size: 8 * MiB, chunk: 64 * KiB, stallAt: 2 });
    await Bun.sleep(100);
    await client(running, "crash", undefined);
    await waitFor(async () => {
      const seen = await report(running);
      return (
        seen.cancelled.includes("RACK_DEVICE_FAULT") &&
        seen.consumeErrors.includes("RACK_DEVICE_FAULT")
      );
    });
  });

  test("a watchdog bite fails the open streams with RACK_DEVICE_FAULT", async () => {
    const { running } = await startRack(RACK, { watchdog: 1_000 });
    const opened = await client(running, "open", { args: { size: 8 * MiB, chunk: 64 * KiB } });
    await Bun.sleep(100);
    expect(await codeOf(running.call("streamer.streams", "block", 3_000))).toBe(
      "RACK_DEVICE_FAULT",
    );
    expect(await client(running, "read", { id: opened })).toMatchObject({
      code: "RACK_DEVICE_FAULT",
    });
  });

  test("a consumer that the rack ends as planned cancels its streams with RACK_LINK_DOWN", async () => {
    const { running } = await startRack(RACK, { drainTimeout: 300 });
    await client(running, "upload", { size: 8 * MiB, chunk: 64 * KiB, stallAt: 2 });
    await Bun.sleep(100);
    await running.unplug("stream-client");
    await waitFor(async () => (await report(running)).consumeErrors.includes("RACK_LINK_DOWN"));
  });
});
