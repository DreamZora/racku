import { connector, device, rpc } from "rack42u";
import { z } from "zod";

/**
 * A connector whose schemas come from zod, which declares a stream as an instance of
 * `ReadableStream`. It lives here, not in `connectors.ts`, because the temporary apps of other
 * tests copy that file and link valibot only.
 */
const ZodStreams = connector("test.zod-streams/v1", {
  /** Reads the stream and returns how many bytes it carried. */
  count: rpc(z.object({ bytes: z.instanceof(ReadableStream) }), z.number()),
});

/** Counts the bytes of streams that a zod schema declares. */
export default device({
  model: "zod-counter",
  provides: { zod: ZodStreams },
  powerOn: () => ({
    zod: {
      async count({ bytes }) {
        let total = 0;
        for await (const chunk of bytes as ReadableStream<Uint8Array>) total += chunk.byteLength;
        return total;
      },
    },
  }),
});
