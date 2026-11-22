import { device, type RackError } from "racku";
import { Bytes, BytesClient } from "../connectors.ts";

/** Calls the bytes provider from inside the rack, and writes into shared buffers it receives. */
export default device({
  model: "bytes-client",
  needs: { bytes: Bytes },
  provides: { client: BytesClient },
  powerOn(ctx) {
    ctx.on.bytes.shared(({ shared }) => {
      new Uint8Array(shared)[0] = 7;
    });
    return {
      client: {
        async send({ size, move }) {
          const bytes = new Uint8Array(size).fill(1);
          const pending = ctx.ports.bytes.inspect(
            { bytes },
            move ? { transfer: [bytes.buffer] } : {},
          );
          const detachedAtOnce = bytes.buffer.detached;
          return { ...(await pending), detachedAtOnce };
        },
        async fetch({ size, move }) {
          const bytes = await ctx.ports.bytes.make({ size, fill: 2, move });
          return { length: bytes.byteLength, sum: bytes.reduce((total, byte) => total + byte, 0) };
        },
        async fail(how) {
          const bytes = new Uint8Array(16);
          const transfer = [bytes.buffer];
          let pending: Promise<unknown>;
          if (how === "cancelled") {
            pending = ctx.ports.bytes.inspect({ bytes }, { signal: AbortSignal.abort(), transfer });
          } else if (how === "timeout") {
            pending = ctx.ports.bytes.write(
              { bytes, value: 9, ms: 300 },
              { timeout: 20, transfer },
            );
          } else if (how === "uncloneable") {
            const input = { bytes, callback: () => {} };
            pending = ctx.ports.bytes.inspect(input, { transfer });
          } else {
            const shared = new SharedArrayBuffer(8) as unknown as ArrayBuffer;
            pending = ctx.ports.bytes.inspect({ bytes }, { transfer: [bytes.buffer, shared] });
          }
          const code = await pending.then(
            () => "none",
            (error: RackError) => error.code,
          );
          return { code, detached: bytes.buffer.detached };
        },
        async sends({ n, gapMs, size }) {
          const calls: Promise<{ sum: number }>[] = [];
          let detachedAtOnce = true;
          for (let i = 0; i < n; i++) {
            const bytes = new Uint8Array(size).fill(i % 256);
            calls.push(ctx.ports.bytes.inspect({ bytes }, { transfer: [bytes.buffer] }));
            detachedAtOnce &&= bytes.buffer.detached;
            await Bun.sleep(gapMs);
          }
          const results = await Promise.all(calls);
          return { detachedAtOnce, sums: results.map((result) => result.sum) };
        },
        async share() {
          const shared = new SharedArrayBuffer(4);
          await ctx.ports.bytes.mark({ shared, value: 42 });
          return new Uint8Array(shared)[0] as number;
        },
      },
    };
  },
});
