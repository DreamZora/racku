# The HTTP panel

## Mounting the panel

`httpPanel(config, options?)` mounts the HTTP panel, `http-panel`. It listens for HTTP and WebSocket on a [listener](listeners.md) of its own, and passes each request, and each WebSocket message, to the port its route names. Such a port implements `http/v2`, to which `httpHandler` adapts a fetch-style function:

```ts
// devices/web.ts
import { device } from "racku";
import { Http, httpHandler } from "racku/std";
import { Greeter } from "../connectors.ts";

export default device({
  model: "web",
  needs: { greeter: Greeter },
  provides: { http: Http },
  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      const name = new URL(request.url).searchParams.get("name") ?? "world";
      return new Response(await ctx.ports.greeter.greet({ name }));
    }),
  }),
});
```

## Routes

`routes` maps [Bun route patterns](https://bun.sh/docs/api/http#routing), such as `/orders/:id` and `/api/*`, to `<device>.<port>` addresses. Each distinct address is a need of the panel, which [`patched()`](devices.md#needs-from-configuration) wires to it, named after the address with `.` and `-` as `_`, such as `orders_http`, and with a `_` in front of a leading digit. So the rules of needs apply:

- The panel sits above every device it routes to. A route to a device that isn't below it, to an unknown device, or to a port that isn't `http/v2` fails with `RACK_MANIFEST`. Two addresses that give one need name fail with `RACK_INVALID_CONFIG`.
- In a scanned rack, list the panel in `roots`; its routes pull in the models they name.
- Each request goes to the instance installed at that moment, so swaps of the devices behind the panel don't interrupt it. A swap that removes a routed port is refused, as for any port in use.
- Editing the panel's configuration, its routes included, replaces the panel without a restart. A new port moves its listener.
- `{ name }` in `options` names a panel other than `http-panel`, so that a rack can mount several, such as a public one and an admin one on another port.
- A request reaches a route only when its path, as Bun normalizes it in the URL that the device gets, still matches the route's pattern, with the same parameters. Bun matches a route on the raw path, so `/api/%2e%2e/admin` or `/api/..\admin` would reach `/api/*` while the device saw `/admin`. Such a request gets 404 with `RACK_NO_ROUTE`, as an unmatched path does. A path whose dot segments stay inside its route, such as `/api/x/../y`, reaches it as `/api/y`.
- Route parameters arrive percent-decoded: `/files/:name` gives `a/b` for `/files/a%2Fb`. Check a parameter before you put it in a path.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `hostname` | `127.0.0.1` | The address to listen on. `0.0.0.0` listens on every IPv4 interface. |
| `port` | required | 0 to 65 535. 0 picks a free port, which the panel keeps while the rack runs, and which the log's `listening` entry and `status()` show. |
| `routes` | required | Route patterns mapped to `<device>.<port>` addresses. Unmatched paths get 404. |
| `allowedHosts` | none | More names that clients may send as `Host` to a panel on a loopback `hostname`, besides its address and `localhost`. Other hosts get 403. |
| `maxBodySize` | 1 MiB | The largest request body, in bytes. A larger one gets 413. |
| `streamThreshold` | 256 KiB | The largest request body, in bytes, that goes to the device whole. A body up to it, with a declared length or chunked, must arrive within `idleTimeout`; a larger one streams. |
| `idleTimeout` | 10 | Seconds, 1 to 255. An idle connection closes, a body sent whole that hasn't arrived within it fails, and so does a streamed body that moves nothing for so long, or that comes slower than 1 KiB/s once it has passed. |
| `tls` | none | `{ cert, key }`, or a list of `{ cert, key, serverName }` for SNI: paths of PEM files, relative to the base directory. |
| `certificateCheck` | 60 | How often the panel checks its certificate files, in seconds, 1 to 3 600. |
| `webSocket.maxMessageSize` | 1 MiB | The largest message a client may send, in bytes. A larger one closes its WebSocket with 1009. |
| `webSocket.maxConnections` | 10 000 | The most WebSockets, open or being upgraded. Upgrades beyond them get 503. |

A configuration that doesn't validate fails the panel's boot with `RACK_INVALID_CONFIG`.

## Requests

The panel's call carries the method, URL, headers, route parameters, and body. `httpHandler` hands your function a standard `Request`, whose `signal` aborts when the client goes away or the call times out, and keeps duplicate response headers, such as several `Set-Cookie` headers.

- **Bodies.** A request body of at most the panel's `streamThreshold`, 256 KiB by default, goes to the device whole, with a declared length or chunked, and a longer one streams, as [Streams](data.md#streams) describes. Either way, it reaches your function as `request.body`. A response body that ends at once within `httpHandler`'s `streamThreshold`, 16 MiB by default, goes back whole, and any other streams, so server-sent events and large downloads start at once:

  ```ts
  http: httpHandler({ fetch: app.fetch, streamThreshold: 256 * 1024 }), // responses over 256 KiB stream
  ```

  A body sent whole moves in one message, which is faster, while it holds all of its bytes until the other side takes them; a body that streams holds at most a stream's window in flight, and the slower side slows the other. `streamThreshold` is an integer of 0 or more, and 0 streams every body that has bytes.

  A response body sent whole keeps its `Content-Length` below 1 MiB, as [`wholeResponse()`](listeners.md) builds it. From 1 MiB on, it goes out in pieces of 256 KiB, with chunked encoding and without `Content-Length`, since Bun can't send a stream with its length, and only a stream shows how far the client got. The panel watches the pieces: when the client takes none for `idleTimeout`, the panel ends the response abruptly, and lets the body go, so that a client that stops reading can't hold it, and the log warns `a client stopped reading its response`, at most once a minute, with how many came since. A `HEAD` request gets the head that a `GET` gets. A body that streams goes out with chunked encoding too, without `Content-Length`, even when the device names one.

  A file goes out with its `Content-Length` at every size when the device answers with [`fileResponse()`](listeners.md#files): `httpHandler` sends the panel the file's absolute path, without reading the file, and the panel sends it from disk as the client reads it. A file that is gone or can't be read when the panel opens it gets 502 with `RACK_DEVICE_FAULT`, and its path goes to the panel's log, not to the client.
- **Timeouts.** The call's timeout, `callTimeout`, runs from the end of the request body to the response head. A body sent whole must arrive within `idleTimeout`, so a client must send at least `streamThreshold / idleTimeout` on average, 25.6 KiB/s with the defaults, for the largest; raise `idleTimeout`, or lower `streamThreshold`, for slower clients. A chunked body, whose length the panel doesn't know, must end or pass `streamThreshold` within `idleTimeout` too. A body that streams fails once it moves nothing for `idleTimeout`, in either direction. Once its first `idleTimeout` has passed, it must also have come at 1 KiB/s or more on average, over the time that the panel waited for the client's bytes; time that the device took to read them doesn't count. So a body of 1 MiB may take about 17 minutes, and a client can't hold a device's calls with bodies that barely move. Bun's own timer, which would cut a whole exchange, doesn't run while a request is under way.
- **Statuses.** Where the panel writes the body, it is JSON, `{ code, message }`. For the rack's own codes, those that start with `RACK_`, such as `RACK_DEVICE_FAULT` for an exception in the device, the message says what happened in general terms, such as "the device failed", so that a client doesn't learn a device's names, paths, or limits. The panel's log gets the details, as a warning at most once a minute for each code and route target, with `since`, how many came after the last warning. A code that the device defines keeps the message that the device sent.

  | Outcome | Status |
  |---|---|
  | `RACK_LINK_DOWN`, or `RACK_OVERLOADED`, also at the need's `queueLimit` | 503 |
  | No response head within `callTimeout`, or a device that stopped reading the body for `idleTimeout` | 504 |
  | A body sent whole that hasn't arrived within `idleTimeout`, or a streamed body that the client stopped sending for `idleTimeout`, or sent slower than 1 KiB/s | 408, and a warning in the log at most once a minute, with how many came since |
  | Any other error, and response headers that `Response` rejects | 502 |
  | A body over `maxBodySize` | 413, with an empty body. When the body was streaming to the device, the device's read of it fails with `RACK_INVALID_INPUT` too. |
  | Another host, on a loopback `hostname` | 403 |
  | No route matches, or a path that normalizing takes out of its route | 404, with the code `RACK_NO_ROUTE` |

- **Clients.** The panel gives a device no client address. A panel that the internet reaches belongs behind a reverse proxy, which can buffer bodies, and limit clients by their address.

- **After the head.** A response body that fails, or moves nothing for `idleTimeout`, after its head went out ends the response abruptly, so the client sees an incomplete body. A client that goes away cancels the call and its streams, with `RACK_CANCELLED` at the device.

A file store puts these together. An upload streams to disk as it comes, and `maxBodySize` bounds it: a larger one gets 413, and fails the device's read with `RACK_INVALID_INPUT`, so the store removes what it wrote. A download leaves from disk with its `Content-Length`:

```ts
// devices/files.ts
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { device, fileResponse } from "racku";
import { Http, httpHandler } from "racku/std";

/** A file's name: 1 to 64 letters, digits, `.`, `_`, and `-`, from a letter or a digit. */
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

export default device({
  model: "files",
  provides: { http: Http },
  async powerOn(ctx) {
    const dir = join(ctx.baseDir, "data", "files");
    await mkdir(dir, { recursive: true });
    return {
      http: httpHandler(async (request) => {
        const name = new URL(request.url).pathname.split("/").at(-1) ?? "";
        if (!NAME.test(name)) return new Response("bad name", { status: 400 });
        const path = join(dir, name);
        if (request.method === "PUT") {
          // Written as it streams in, then renamed, so that a download never gets half a file.
          const draft = join(dir, `.${crypto.randomUUID()}`);
          try {
            await Bun.write(draft, new Response(request.body));
            await rename(draft, path);
          } finally {
            await rm(draft, { force: true });
          }
          return new Response(null, { status: 204 });
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response(null, { status: 405 });
        }
        if (!(await Bun.file(path).exists())) return new Response("not found", { status: 404 });
        return fileResponse(path);
      }),
    };
  },
});
```

Behind a panel with `routes: { "/files/:name": "files.http" }`, it keeps each file in `data/files/` under the base directory.

## WebSocket

WebSocket is part of the HTTP panel, on the same routes. For it, `httpHandler` takes WebSocket handlers and the port's emitter:

```ts
powerOn: (ctx) => ({
  http: httpHandler(
    {
      fetch(request, server) {
        if (request.headers.get("origin") !== "https://app.example") {
          return new Response("forbidden", { status: 403 });
        }
        if (server.upgrade(request, { data: { user: "ann" }, protocol: "chat" })) return;
        return new Response("hello");
      },
      websocket: {
        open: (ws) => ws.send("welcome"),
        message: (ws, data) => ws.send(data),
        close(ws, code, reason) {},
      },
    },
    ctx.emit.http, // what the sockets send travels as this port's events
  ),
}),
```

- **Upgrades.** An upgrade request reaches `fetch` like any request. `server.upgrade(request, { headers?, data?, protocol? })` accepts it, and `fetch` then returns nothing; without `protocol`, the client gets the first subprotocol it offered. Any response refuses it. An upgrade that the device accepted but that doesn't complete, because Bun refuses it, its client left, or the device's headers or subprotocol aren't valid HTTP, reaches the device as a `closed` call with 1006, and the client gets 400, or 502 for headers that aren't valid. `httpHandler` forgets such an upgrade then, or once its socket hasn't opened for 10 s, and keeps at most 10 000 that wait to open.
- **Messages.** Text arrives as a string, and binary as a `Uint8Array`. Each message is a call, and a socket has at most 16 unfinished: beyond that, the panel stops reading the socket, so the client sees backpressure, and the calls start in the order the messages arrived. A failed `open` or `message` closes the socket, with 1013 for the codes that give 503, and 1011 for the others.
- **Sockets.** Each socket has an `id`, `<panel>:<instance>:<n>`, its `data`, the value that `server.upgrade()` gave it, and `send()` and `close()`, which travel as the port's `send` and `close` events. `handler.list()` returns the sockets that the instance knows, each as `{ socket, data }`, its id and its data. A device can emit `send` and `close` itself too, to one id or a list, as the example below does. Each panel takes the events for its own sockets and ignores the others, so several panels can share one port.
- **Swaps.** A hot swap of the device keeps its sockets open. Return `handler.list()` in the state of `snapshot`, and pass it to `handler.restore(list)` in `restore`, so that the new instance knows them. Without that, the new instance doesn't know them, and the next message of each closes it with 1011. A reset or a restart of the device loses them: their sockets close with 1011, at their next message, or at the panel's second check of its sockets, which runs every 30 s. Swapping the panel closes its WebSockets with 1012, once the messages in flight on them are handled; clients must reconnect.
- **Limits.** Upgrades take their places among `maxConnections` before the panel calls the device, so a burst of them can't pass it. A client that reads too slowly, with more than 1 MiB unsent, is closed with 1013. When the panel crashes, its clients' connections end, and each device behind it runs its `close` handler with 1006, "abnormal closure", for the panel's sockets, at its first call after 90 s without a call from that panel.
- **Origins.** Browsers apply no CORS to WebSockets, and any web page can send requests to `127.0.0.1`. A panel on loopback refuses other `Host` names, which stops a page that points its own domain at `127.0.0.1`, but not one that uses the address itself. So a device behind a panel checks the `Origin` of WebSocket upgrades, and of requests that change state, itself.

A chat room, for example, sends each message to every socket in the sender's room. The room is each socket's data, and the list of the sockets is the room's members:

```ts
// devices/room.ts
import { device } from "racku";
import { Http, type HttpHandler, httpHandler } from "racku/std";

export default device({
  model: "room",
  provides: { http: Http },
  powerOn(ctx) {
    const handler: HttpHandler<{ room: string }> = httpHandler(
      {
        fetch(request, server) {
          const room = new URL(request.url).searchParams.get("room") ?? "lobby";
          if (server.upgrade(request, { data: { room } })) return;
          return new Response("this room needs a WebSocket", { status: 426 });
        },
        websocket: {
          // Each message goes to every socket in the sender's room, the sender's own included.
          message(ws, data) {
            if (typeof data !== "string") {
              ws.close(1003, "this room takes text");
              return;
            }
            const members = handler.list().filter((member) => member.data.room === ws.data.room);
            return ctx.emit.http.send({ socket: members.map((member) => member.socket), data });
          },
        },
      },
      ctx.emit.http,
    );
    return { http: handler };
  },
});
```

In a hot swap, the rooms move to the new instance with the list, when `snapshot` and `restore` hand it over as **Swaps** says. [Devices behind a panel](testing.md#devices-behind-a-panel) tests the room on the bench.

## Certificates

With `tls`, the panel serves HTTPS and WSS, and a pair that doesn't load fails its `powerOn`.

- Every `certificateCheck` seconds, the panel reads the files again. A pair that changed and loads replaces the old one without a restart: new connections get it, and connections opened before keep working. With SNI, each pair is checked on its own, and unknown names get the first.
- A pair that changed and doesn't load, such as a key that doesn't match its certificate, leaves the old pair serving. If it still doesn't load at the next check, the log has an error, `certificates rejected`, once until its files change again. So a renewal that writes the certificate and then the key loads at the check after the second write, without an error.
- Tools that renew certificates should write each file under a temporary name and rename it, so that the panel never reads half a file.
- `status()` shows each certificate's subject and expiry, `notAfter`, in the entry of the panel's listener.

## Observation

The panel's needs count its calls per route target, as every need does, with `streams` for the bodies that streamed. The entry of its listener in `status()` shows its requests in flight and its open WebSockets. Answers for which no call reached a device count nowhere, such as 404, 403, and 413 for a declared length. The log warns when the panel starts refusing upgrades at `maxConnections`, and says when it accepts them again. It warns at most once a minute of a kind, with `since`, how many came after the last warning: of a request that failed with one of the rack's codes, for each code and route target; of a client whose body stalled or came too slowly; and of a client that stopped reading its response.

## The http/v2 connector

`http/v2` has these members:

| Member | Kind | Carries |
|---|---|---|
| `handle` | RPC | `{ method, url, headers, params, body, socket? }` to `{ status, headers, body }`, or to `{ upgrade: { protocol?, headers? } }` for an upgrade request, which alone carries `socket` |
| `opened`, `closed` | RPC | `{ socket }` when a WebSocket opened, and `{ socket, code, reason }` when it closed |
| `message` | RPC | `{ socket, data }`, a message from the client |
| `sockets` | RPC | `{ instance, open }` to `{ unknown }`: the panel's check of the sockets one side lost |
| `send`, `close` | event | `{ socket, data }` and `{ socket, code?, reason? }`, to one socket id or a list |

Headers are arrays of `[name, value]` pairs, and a body is `null`, a `Uint8Array`, or a stream. `httpHandler` answers `sockets` itself: it treats a socket as closed once two checks in a row from its panel left it out. The panel can send `closed` for an upgrade that the device never accepted, as when the call for it failed; an implementation of its own ignores a socket it doesn't know.
