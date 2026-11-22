import { type CallOptions, device, RackError } from "racku";
import { StreamClient, Streams } from "../connectors.ts";

interface Upload {
  pulled: number;
  cancelled: string | null;
  done: Promise<{ ok: boolean; code: string | null; total: number; deadline: number }>;
}

type Opened = { ok: true; bytes: ReadableStream<Uint8Array> } | { ok: false; code: string };

const uploads = new Map<number, Upload>();
const opened = new Map<number, Promise<Opened>>();
let nextId = 1;

function codeOf(reason: unknown): string {
  return reason instanceof RackError ? reason.code : String(reason);
}

function optionsOf(timeout?: number, streamTimeout?: number): CallOptions {
  const options: CallOptions = {};
  if (timeout !== undefined) options.timeout = timeout;
  if (streamTimeout !== undefined) options.streamTimeout = streamTimeout;
  return options;
}

/** Calls the streams device through a need, for the stream tests of links. */
export default device({
  model: "stream-client",
  needs: { streams: Streams },
  provides: { client: StreamClient },
  powerOn: (ctx) => ({
    client: {
      upload(args) {
        const id = nextId++;
        let index = 0;
        const entry: Upload = {
          pulled: 0,
          cancelled: null,
          done: Promise.resolve({ ok: false, code: null, total: 0, deadline: 0 }),
        };
        const bytes = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (args.sourceDelay) await Bun.sleep(args.sourceDelay);
              if (args.stallAt !== undefined && index >= args.stallAt) {
                // Never settles: the stream moves nothing more until it is cancelled.
                await new Promise(() => {});
              }
              if (entry.pulled >= args.size) {
                controller.close();
                return;
              }
              const length = Math.min(args.chunk, args.size - entry.pulled);
              controller.enqueue(new Uint8Array(length).fill(1));
              entry.pulled += length;
              index++;
            },
            cancel(reason) {
              entry.cancelled = codeOf(reason);
            },
          },
          { highWaterMark: 0 },
        );
        const { take, delay, after } = args;
        entry.done = ctx.ports.streams
          .consume({ bytes, take, delay, after }, optionsOf(args.timeout, args.streamTimeout))
          .then(
            (value) => ({
              ok: true,
              code: value.error,
              total: value.total,
              deadline: value.deadline,
            }),
            (error: unknown) => ({ ok: false, code: codeOf(error), total: 0, deadline: 0 }),
          );
        uploads.set(id, entry);
        return id;
      },
      pulled: (id) => uploads.get(id)?.pulled ?? -1,
      async finished(id) {
        const entry = uploads.get(id);
        if (entry === undefined) throw new RackError("NO_UPLOAD", `no upload ${id}`);
        const outcome = await entry.done;
        // A cancel of the source can arrive a moment after the result.
        await Bun.sleep(30);
        return { ...outcome, cancelled: entry.cancelled };
      },
      open({ args, timeout, streamTimeout }) {
        const id = nextId++;
        const produce = ctx.ports.streams.produce as (
          input: unknown,
          options?: CallOptions,
        ) => Promise<{ bytes: ReadableStream<Uint8Array> }>;
        opened.set(
          id,
          produce(args, optionsOf(timeout, streamTimeout)).then(
            (value): Opened => ({ ok: true, bytes: value.bytes }),
            (error: unknown): Opened => ({ ok: false, code: codeOf(error) }),
          ),
        );
        return id;
      },
      async read({ id, delay, cancelAt }) {
        const result = await opened.get(id);
        if (result === undefined) throw new RackError("NO_STREAM", `no stream ${id}`);
        if (!result.ok) return { ok: false, code: result.code, total: 0, chunks: 0, largest: 0 };
        const reader = result.bytes.getReader();
        let total = 0;
        let chunks = 0;
        let largest = 0;
        try {
          for (;;) {
            if (cancelAt !== undefined && chunks >= cancelAt) {
              await reader.cancel();
              break;
            }
            if (delay) await Bun.sleep(delay);
            const { done, value } = await reader.read();
            if (done) break;
            chunks++;
            total += value.byteLength;
            largest = Math.max(largest, value.byteLength);
          }
        } catch (error) {
          return { ok: true, code: codeOf(error), total, chunks, largest };
        }
        return { ok: true, code: null, total, chunks, largest };
      },
      crash() {
        setTimeout(() => process.exit(3), 10);
      },
    },
  }),
});
