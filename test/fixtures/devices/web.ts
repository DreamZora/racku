import { device, fileResponse } from "racku";
import { Http, httpHandler } from "racku/std";

// Tests that exercise `rack dev` edit this line in a copy of the file.
const GREETING = "hello";

/** Which instance this is: every instance of the device has its own. */
const instance = Math.random().toString(36).slice(2, 8);
/** Bytes that downloads have produced, as their sources were pulled. */
let produced = 0;

/** Streams `size` bytes in chunks of `chunk`, or text lines `gap` ms apart. */
function body(
  chunks: number,
  make: (i: number) => Uint8Array,
  gap = 0,
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (sent > 0 && gap > 0) await Bun.sleep(gap);
        if (sent === chunks) {
          controller.close();
          return;
        }
        controller.enqueue(make(sent++));
      },
    },
    { highWaterMark: 0 },
  );
}

const app = httpHandler(async (request) => {
  const url = new URL(request.url);
  const number = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);
  switch (url.pathname) {
    case "/web/greeting":
      return new Response(GREETING);
    case "/web/who":
      return new Response(instance);
    case "/web/echo":
      return Response.json({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: [...request.headers],
        body: await request.text(),
      });
    case "/web/cookies": {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("ok", { headers });
    }
    case "/web/sleep":
      await Bun.sleep(number("ms", 0));
      return new Response("slept");
    case "/web/slow":
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    case "/web/boom":
      throw new Error("boom");
    case "/web/crash":
      process.exit(3);
      break;
    case "/web/upload": {
      // Reads the body as it streams in, `delay` ms per chunk, and once it has read `hold`
      // bytes, stops reading for `ms` ms.
      let total = 0;
      const delay = number("delay", 0);
      let hold = number("hold", Number.POSITIVE_INFINITY);
      for await (const chunk of request.body ?? []) {
        total += chunk.byteLength;
        if (delay > 0) await Bun.sleep(delay);
        if (total >= hold) {
          hold = Number.POSITIVE_INFINITY;
          await Bun.sleep(number("ms", 0));
        }
      }
      return new Response(String(total));
    }
    case "/web/produced":
      return new Response(String(produced));
    case "/web/file": {
      // The file that the query names, with the Content-Disposition it names, if any.
      const disposition = url.searchParams.get("disposition");
      const init = disposition === null ? {} : { headers: { "content-disposition": disposition } };
      return fileResponse(url.searchParams.get("path") ?? "", init);
    }
    case "/web/ignore-body":
      // Never reads the body, so the panel's stream of it stalls.
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    case "/web/download": {
      const size = number("size", 1024 * 1024);
      const chunk = number("chunk", 64 * 1024);
      produced = 0;
      return new Response(
        body(Math.ceil(size / chunk), () => {
          produced += chunk;
          return new Uint8Array(chunk).fill(7);
        }),
      );
    }
    case "/web/events": {
      const n = number("n", 3);
      const encoder = new TextEncoder();
      return new Response(
        body(n, (i) => encoder.encode(`data: ${i}\n\n`), number("gap", 200)),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    case "/web/broken": {
      // The head goes out, then the body fails after its first chunk.
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) {
              await Bun.sleep(20);
              throw new Error("the body broke");
            }
            sent = true;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      );
    }
    case "/web/stall": {
      // The head goes out, then the body stalls after its first chunk.
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) await new Promise(() => {});
            sent = true;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }),
      );
    }
  }
  return new Response("no such page", { status: 404 });
});

export default device({
  model: "web",
  provides: { http: Http },
  powerOn: () => ({
    http: {
      ...app,
      // A raw http/v2 implementation for two paths: one shows the route parameters, and one
      // answers with a header name that `Response` rejects.
      handle(input, call) {
        if (input.url.includes("/items/")) {
          const headers: [string, string][] = [["content-type", "application/json"]];
          const body = new TextEncoder().encode(JSON.stringify(input.params));
          return { status: 200, headers, body };
        }
        if (input.url.includes("/bad-header")) {
          const headers: [string, string][] = [["bad header", "x"]];
          return { status: 200, headers, body: null };
        }
        if (input.url.includes("/relative-file")) {
          return { status: 200, headers: [], body: { file: "relative.bin" } };
        }
        return app.handle(input, call);
      },
    },
  }),
});
