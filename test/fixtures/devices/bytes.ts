import { device, RackError } from "rack42u";
import { Bytes } from "../connectors.ts";

let kept: Uint8Array<ArrayBuffer> | undefined;
let published: SharedArrayBuffer | undefined;

/** Provides binary data that it copies, moves, or shares, as each test asks. */
export default device({
  model: "bytes",
  provides: { bytes: Bytes },
  powerOn: (ctx) => ({
    bytes: {
      inspect: ({ bytes }) => ({
        length: bytes.byteLength,
        sum: bytes.reduce((total, byte) => total + byte, 0),
      }),
      make({ size, fill, move, fail }, call) {
        const bytes = new Uint8Array(size).fill(fill);
        kept = bytes;
        if (move) call.transfer(bytes.buffer);
        if (fail) throw new RackError("BYTES_FAILED", "failed after listing the bytes");
        return bytes;
      },
      kept: () => ({ length: kept?.byteLength ?? -1, detached: kept?.buffer.detached ?? false }),
      badTransfer(_input, call) {
        call.transfer(new SharedArrayBuffer(8) as unknown as ArrayBuffer);
      },
      async write({ bytes, value, ms }) {
        await Bun.sleep(ms);
        bytes[0] = value;
      },
      mark({ shared, value }) {
        new Uint8Array(shared)[0] = value;
      },
      async publish() {
        published = new SharedArrayBuffer(4);
        await ctx.emit.bytes.shared({ shared: published });
      },
      lend() {
        published = new SharedArrayBuffer(4);
        return published;
      },
      peek: () => (published === undefined ? -1 : (new Uint8Array(published)[0] as number)),
    },
  }),
  // Handing over state makes a swap hold the slot while the old instance finishes its calls.
  snapshot: () => ({}),
  restore() {},
});
