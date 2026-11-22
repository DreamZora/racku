import { device, RackError } from "racku";
import { Streams } from "../connectors.ts";

/** Bytes the instance's sources made. */
let produced = 0;
/** The codes the instance's sources were cancelled with, in order. */
const cancelled: string[] = [];
/** Buffers that a source found detached after it enqueued them. */
let detached = 0;
/** The codes of the input streams that failed while `consume` read them. */
const consumeErrors: string[] = [];
let snapshotDelay = 0;

function codeOf(reason: unknown): string {
  return reason instanceof RackError ? reason.code : String(reason);
}

function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy on purpose: the event loop gets no turn.
  }
}

interface SourceOptions {
  size: number;
  chunk: number;
  fill?: number | undefined;
  delay?: number | undefined;
  failAt?: number | undefined;
  junk?: boolean | undefined;
  stall?: boolean | undefined;
  reuse?: boolean | undefined;
}

/** A source that makes each chunk only when the stream reads it, as `produce` describes. */
function source(options: SourceOptions): ReadableStream<Uint8Array> {
  const fill = options.fill ?? 1;
  let sent = 0;
  let index = 0;
  const shared = options.reuse ? new Uint8Array(options.chunk) : undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (options.delay) await Bun.sleep(options.delay);
        if (options.stall && index >= 1) {
          // Never settles: the stream moves nothing more until it is cancelled.
          await new Promise(() => {});
        }
        if (options.junk && index === 0) {
          index++;
          controller.enqueue("not bytes" as unknown as Uint8Array);
          return;
        }
        if (options.failAt !== undefined && index === options.failAt) {
          controller.error(new RackError("SOURCE_FAILED", "the source failed on purpose"));
          return;
        }
        if (sent >= options.size) {
          controller.close();
          return;
        }
        const length = Math.min(options.chunk, options.size - sent);
        let bytes: Uint8Array;
        if (shared !== undefined) {
          // The next chunk overwrites the buffer this one was enqueued in.
          shared.fill(fill + index);
          bytes = shared.subarray(0, length);
        } else bytes = new Uint8Array(length).fill(fill);
        controller.enqueue(bytes);
        if ((bytes.buffer as ArrayBuffer).detached) detached++;
        sent += length;
        produced += length;
        index++;
      },
      cancel(reason) {
        cancelled.push(codeOf(reason));
      },
    },
    { highWaterMark: 0 },
  );
}

/** Produces, consumes, and echoes byte streams for the stream tests. */
export default device({
  model: "streamer",
  provides: { streams: Streams },
  powerOn: (ctx) => ({
    streams: {
      async consume({ bytes, take, delay, after }, call) {
        const reader = bytes.getReader();
        let total = 0;
        let chunks = 0;
        let largest = 0;
        let sum = 0;
        let error: string | null = null;
        try {
          while (take === undefined || chunks < take) {
            if (delay) await Bun.sleep(delay);
            const { done, value } = await reader.read();
            if (done) break;
            chunks++;
            total += value.byteLength;
            largest = Math.max(largest, value.byteLength);
            for (const byte of value) sum += byte;
          }
        } catch (failure) {
          error = codeOf(failure);
          consumeErrors.push(error);
        }
        reader.releaseLock();
        if (after) await Bun.sleep(after);
        return { total, chunks, largest, sum, deadline: call.deadline, error };
      },
      produce: (options) => ({ size: options.size, bytes: source(options) }),
      echo: (input) => input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()),
      report: () => ({
        firmware: ctx.firmware,
        produced,
        cancelled: [...cancelled],
        detached,
        consumeErrors: [...consumeErrors],
      }),
      bad(how) {
        const one = () => source({ size: 4, chunk: 4 });
        return how === "two" ? { a: one(), b: one() } : { inner: { bytes: one() } };
      },
      async publish() {
        await ctx.emit.streams.streamed(source({ size: 4, chunk: 4 }));
      },
      slowSnapshot(ms) {
        snapshotDelay = ms;
      },
      crash() {
        setTimeout(() => process.exit(3), 10);
      },
      block(ms) {
        spin(ms);
      },
    },
  }),
  async snapshot(ctx) {
    ctx.log.info("hook", { hook: "snapshot" });
    if (snapshotDelay > 0) await Bun.sleep(snapshotDelay);
    return {};
  },
  restore() {},
});
