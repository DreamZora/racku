import { device } from "racku";
import { Http, httpHandler } from "racku/std";

/**
 * Answers with a body in memory of the size that `?size=` names. Bodies up to 128 MiB go back to
 * the panel whole, so that a test can send one larger than a system's socket buffers can take.
 */
export default device({
  model: "big",
  provides: { http: Http },
  powerOn: () => ({
    http: httpHandler({
      fetch: (request) => {
        const size = Number(new URL(request.url).searchParams.get("size") ?? 0);
        return new Response(new Uint8Array(size).fill(7));
      },
      streamThreshold: 128 * 1024 * 1024,
    }),
  }),
});
