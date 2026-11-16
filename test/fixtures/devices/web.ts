import { device, Http, httpHandler } from "rack42u";

// Tests that exercise `rack dev` edit this line in a copy of the file.
const GREETING = "hello";

const app = httpHandler(async (request) => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/web/greeting":
      return new Response(GREETING);
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
    case "/web/slow":
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    case "/web/boom":
      throw new Error("boom");
    case "/web/crash":
      process.exit(3);
      break;
  }
  return new Response("no such page", { status: 404 });
});

export default device({
  model: "web",
  provides: { http: Http },
  powerOn: () => ({
    http: {
      // A raw http/v1 implementation for one path, to observe the route parameters.
      handle: (input, call) =>
        input.url.includes("/items/")
          ? {
              status: 200,
              headers: [["content-type", "application/json"] as [string, string]],
              body: new TextEncoder().encode(JSON.stringify(input.params)),
            }
          : app.handle(input, call),
    },
  }),
});
