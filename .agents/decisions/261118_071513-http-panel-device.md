# Decision: The standard HTTP panel device, with WebSocket and TLS

Status: accepted

## Background

- [Panels as devices, with listeners that survive swaps](261118_070617-panels-as-devices.md) makes panels devices. The rack's main thread holds no external connections, and devices open listeners with `ctx.serve`, which the rack hands over across swaps. The HTTP panel that the rack opens on its main thread today has to become such a device.
- [Byte streams in calls between devices](261118_071155-backplane-streams.md) lets calls carry byte streams, with flow control.
- Today's panel, as the [background of the panels decision](261118_070617-panels-as-devices.md#background) describes, is configured by the manifest's `panel.http`:
  - `routes` maps Bun route patterns, such as `/orders/:id` and `/api/*`, to `<device>.<port>` addresses of `http/v1` ports.
  - `http/v1` has one member, `handle`. Its input is `{ method, url, headers, params, body }`, its output `{ status, headers, body }`, and a body is a `Uint8Array` or `null`. `httpHandler(fetch)` in `src/http.ts` adapts a fetch-style function. `rack42u` exports both.
  - A failed call maps to 503 for `RACK_LINK_DOWN` and `RACK_OVERLOADED`, 504 for `RACK_TIMEOUT`, and 502 otherwise, with a JSON body `{ code, message }`. Response headers that `Response` rejects give 502 too. Unmatched paths get 404.
  - The rack checks routes at assembly: a route to an unknown device, or to a port that isn't `http/v1`, fails with `RACK_MANIFEST`. A swap that removes a routed port, or changes its connector, fails with `RACK_SWAP_REJECTED`, and a routed device can't be unplugged. In a scanned rack, every model that a route names becomes a root.
  - Its calls count among the calls from outside the rack, under the member `handle` of the routed port.
- On 2026-11-18 the user asked for the HTTP panel:
  - a listen address, loopback by default, and a port;
  - a declared request body limit as a configuration item: "The configuration item I mentioned is the request size issue you brought up earlier";
  - WebSocket support, integrated with the HTTP panel, "WebSocket is a subfeature of HTTP";
  - TLS certificates that load dynamically, "we shouldn't have to restart just to update a certificate when it expires";
  - network components such as the HTTP panel built as devices.
- A panel device needs what the rack's panel gets from the rack today: where each route goes. A device's needs are fixed in its file today, while a panel's targets come from its configuration.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since every limit is declared, the panel listens on loopback unless told otherwise, its network I/O runs in a Worker that a watchdog watches, and certificates change without a restart;
  - maintainability, since the panel is an ordinary standard device, tested on its own, and the rack loses its panel code and its special rules for routes;
  - observability, since each route target has its own counters, and the panel's listener shows its load and when its certificates expire;
  - extensibility, since a rack can mount several panels, devices behind them can serve WebSockets and streams, and any device can be a route target.

### Evidence

Measured on 2026-11-18. The [evidence of the panels decision](261118_070617-panels-as-devices.md#evidence) covers port handovers on Linux, macOS, and Windows, TLS, the body limit, and Bun's idle timeout. The [evidence of the streams decision](261118_071155-backplane-streams.md#evidence) covers backpressure in `Bun.serve` and moving bytes between threads. This adds:

- **Throughput of three ways to serve HTTP**, on the local machine, Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores, with Bun 1.4.4 and probe scripts outside the repository:
  - The load came from 3 client processes on the same machine, each with 64 keep-alive clients, for 3 s, one run per setup.
  - The forwarding passed only the method and the URL, and returned a status and a short body, without schemas, headers, or counters. So the numbers bound the cost of the transport, not of a panel's own work.

  | Setup | Requests/s | Median latency |
  |---|---:|---:|
  | `Bun.serve` on the main thread, forwarding each request to a handler Worker over a `MessagePort`, as the panel does today | 77,839 | 2.38 ms |
  | `Bun.serve` in a Worker, forwarding to the handler Worker, as a panel device does | 85,593 | 2.12 ms |
  | The handler Worker serving HTTP itself, as a device with its own listener does | 128,207 | 1.40 ms |

  - With one client process, the three setups gave 89,352, 89,064, and 94,944 requests/s, limited by the client.
- **WebSocket origins:** browsers send an `Origin` header in a WebSocket handshake but enforce no CORS on it. [RFC 6455, section 10.2](https://www.rfc-editor.org/rfc/rfc6455#section-10.2) leaves the check to the server. So a page on any site can open a WebSocket to `127.0.0.1`.
- **WebSocket details**, on the local machine, one run each:
  - A client that offered the subprotocols `chat` and `other` got `chat` when the server upgraded without a `Sec-WebSocket-Protocol` header, and `other` when the server named it in that header.
  - A handler that called `pause()` at the first of 20,000 small messages still got 7,093 more, which Bun had already read. Of 200 messages of 64 KiB, it got 1 more.
  - A client received the close codes 1001, 1009, 1011, 1012, and 1013 as the server sent them.

## Decision

### The device

- `httpPanel(config, options?)` in `rack42u/std` mounts the standard HTTP panel, as `sqlite(config, options?)` mounts `sqlite`. It returns a mount description only, like the other factories.
- Its model, and so its default device name, is `http-panel`:
  - It says what the device is, fits the name rule `^[A-Za-z0-9][A-Za-z0-9_-]*$`, and matches the factory's name.
  - It leaves `panel` free for other kinds of panels.
  - It doesn't read like the `http` ports of the devices behind it, as in `web.http`.
- `{ name }` in `options` names it otherwise, so a rack can mount several panels, such as a public one and an admin one on another port.
- It provides no ports, has no state to hand over in a swap, swaps hot, and occupies 1 U.

### Configuration

```ts
httpPanel({
  hostname: "127.0.0.1", // the default
  port: 3000, // required; 0 picks a free port
  routes: { "/api/*": "orders.http", "/chat": "chat.http" },
  maxBodySize: 1_048_576, // bytes, the default
  idleTimeout: 10, // seconds, the default
  tls: { cert: "certs/site.crt", key: "certs/site.key" }, // relative to the base directory
  webSocket: { maxMessageSize: 1_048_576, maxConnections: 10_000 }, // the defaults
});
```

| Field | Default | Meaning and bound |
|---|---|---|
| `hostname` | `127.0.0.1` | The address to listen on. `0.0.0.0` listens on every IPv4 interface. |
| `allowedHosts` | none | More names that clients may send as `Host` to a panel on a loopback `hostname`, besides its address and `localhost`. Requests for other hosts get 403, as [`ctx.serve`](261118_070617-panels-as-devices.md#defaults-and-bounds) decides. |
| `port` | required | 0 to 65 535. 0 picks a free port, which `status()` and the log report, and which the panel keeps while the rack runs. |
| `routes` | required | Bun route patterns mapped to `<device>.<port>` addresses of `http/v2` ports. Unmatched paths get 404. |
| `maxBodySize` | 1 MiB | The largest request body, in bytes. A larger one gets 413. |
| `idleTimeout` | 10 s | 1 to 255 s, Bun's limit. An idle keep-alive connection closes after it, and a body that moves no bytes for that long fails. |
| `tls` | none | `{ cert, key }`, or a list of `{ cert, key, serverName }` for SNI: paths of PEM files, relative to the base directory. |
| `certificateCheck` | 60 s | How often the panel checks its certificate files for changes, 1 to 3 600 s. |
| `webSocket.maxMessageSize` | 1 MiB | The largest message a client may send. A larger one closes the WebSocket with 1009. |
| `webSocket.maxConnections` | 10 000 | The most open WebSockets. Upgrades beyond it get 503. |

- The panel validates its configuration with its schema, so a bad one fails with `RACK_INVALID_CONFIG` when the panel boots.
- The other limits are the defaults of [`ctx.serve`](261118_070617-panels-as-devices.md#defaults-and-bounds): a WebSocket idles at most 120 s, with pings, and one that already has more than 1 MiB unsent when the panel sends to it is closed with 1013.

### Requests

- For each request, the panel calls `handle` on the route's port, through its need for that address. The call carries the method, the URL, the headers, the route parameters, and the body. The panel answers with the status, headers, and body that the device returns.
- **Bodies.**
  - A body is `null`, bytes, or a stream, as [Byte streams in calls between devices](261118_071155-backplane-streams.md#streams-in-calls) allows. `GET` and `HEAD` requests, and requests without a body, carry `null`.
  - A request body with a declared length of at most 64 KiB travels as bytes, which saves the stream's messages. Larger and chunked bodies stream. The panel reads a body it sends as bytes under the same idle timeout as a stream, and answers 408 when the client stops sending it.
  - Bun answers 413 to a body over `maxBodySize`, whether its length is declared or it is chunked, as measured on every system. A streamed body that crosses the limit fails at the device with `RACK_INVALID_INPUT`.
  - A device answers with bytes or a stream. A stream starts the response at once, so server-sent events and large downloads work, and the client's pace slows the device's source.
- **Timeouts.**
  - The call's timeout, the rack's `callTimeout` of 30 s, runs from the end of the request body to the response head, as the streams decision sets for a call with an input stream.
  - The bodies' streams use the panel's `idleTimeout` as their `streamTimeout`.
  - Bun's own timer bounds a request's whole exchange instead of its idle time, as the panels decision measured on Linux. So the panel lifts it for each request while its exchange runs, with `listener.timeout(request, 0)`, and sets it back to `idleTimeout` when the exchange ends. `idleTimeout` then bounds idle time, not a whole exchange, within the steps of 4 s in which Bun applies it.
- A client that disconnects cancels the call and its streams, with `RACK_CANCELLED` at the device.
- **Statuses**, with a JSON body `{ code, message }` where the panel writes the body:

  | Outcome | Status |
  |---|---|
  | `RACK_LINK_DOWN` or `RACK_OVERLOADED` | 503 |
  | `RACK_TIMEOUT`: no response head within `callTimeout` of the end of the body, or a device that stopped reading the body for `idleTimeout` | 504 |
  | A client that stopped sending its body for `idleTimeout` | 408 |
  | Any other error, and response headers that `Response` rejects | 502 |
  | A body over `maxBodySize` | 413, from Bun, with an empty body |
  | A request for another host, on a loopback `hostname` | 403, from the listener |
  | No route matches | 404 |

- A response body that fails after the head was sent can't change the status. The panel ends the response abruptly, so the client sees an incomplete body, never a complete one.

### WebSocket

- WebSocket is part of the HTTP panel, on the same server and the same routes.
- **Upgrades.** An upgrade request goes to the route's port as a `handle` call, like any request, with `socket`: an id that the panel assigns, `<panel>:<instance>:<n>`, made of the panel's device name, an id that each instance of the panel draws at boot, and a counter. It is unique in the rack's process.
  - The device accepts the upgrade by answering `{ upgrade: { protocol?, headers? } }`, or refuses it with an ordinary response, such as 401 or 403.
  - Without `protocol`, Bun answers with the first subprotocol that the client offered, as measured on Linux. A device that cares about subprotocols names one.
  - This is where a device checks tokens and the `Origin` header. Browsers apply no CORS to WebSockets, so a page on any site can open one to `127.0.0.1`. The listener's `Host` check stops a page that points its own domain at `127.0.0.1`, but not one that opens `ws://127.0.0.1` by its address, which sends its own `Origin`.
- **Messages from clients.** After the upgrade, the panel calls `opened`, then `message` for each message, with text as a string and binary as bytes, and `closed` when the socket closes, with its code and reason.
  - Message calls start in the order the messages arrived. As with Bun's own handler, an asynchronous handler may see the next message start before it finishes.
  - A socket has at most 16 message calls unfinished. At 16, the panel stops reading it with `pause()`, so the client sees TCP backpressure, and reads again when one finishes.
  - Bun still delivers the messages it read before the pause: 7,093 small ones in the probe on Linux, and 1 of 64 KiB. The panel holds them in order and starts each call as an earlier one finishes, so no socket has more than 16 unfinished.
  - When the panel's instance leaves service, it drops the messages it holds and hasn't started, lets the calls it started finish, and closes the socket, as the [panels decision](261118_070617-panels-as-devices.md#when-listeners-listen) describes.
  - A failed `opened` or `message` call closes the socket: with 1013, "try again later", for the codes the panel answers with 503, and with 1011, "internal error", for the others. A failed `closed` call is only counted.
- **Messages to clients.** The device sends with `send` events, `{ socket, data }`, to one socket or a list of them, and closes sockets with `close` events, `{ socket, code?, reason? }`, on the same port. The panel subscribes to both.
  - Each panel takes the events for the sockets it opened, by the name in their ids, and ignores the others. So several panels can share one port of a device.
  - A panel ignores events for sockets it no longer has, such as ones that already closed, or that an earlier instance of the panel opened.
  - Events are delivered at most once, as every event is. The panel's link drops a `send` only when the panel is `queueLimit` events behind, and the device counts it in `dropped`.
  - An instance sends to sockets once it is installed. Events that an instance emits in standby are dropped, as [Events](261116_024226-backplane-links.md#events) decides.
- **Sockets that one side lost.** The panel holds each WebSocket's connection, and the device its state. A crash or a restart of either one loses its side, while the other side's record stays: a client that only listens would get nothing more, and its socket would stay open. So every 30 s, the panel calls `sockets` on each route target where it has WebSockets, with its instance and the ids of its sockets there whose `opened` call has returned:
  - The device answers with the ids it doesn't know, as after its reset or restart. The panel closes a socket with 1011 once two calls in a row named it.
  - The device treats a socket of that panel instance as closed once two calls in a row left it out. It treats every socket of a panel instance as closed once no call has come from that instance for 90 s, three intervals, as after a crash of the panel, so that one call that fails or waits through a swap doesn't drop a live panel's sockets. A device instance counts that time from its start or its `restore`. `httpHandler` then runs the device's `close` handler for each such socket with 1006, "abnormal closure".
  - Two calls in a row, so that a socket that opens or closes while a call is under way isn't taken for lost. So a socket that its device lost closes within about a minute, and a device forgets the sockets of a panel that crashed within about 90 s.

### Swaps

- Replacing the device behind a route keeps every connection, HTTP and WebSocket.
  - Its calls, message calls included, wait during the swap like any call.
  - Its `send` events reach the panel from whichever instance is installed.
  - It moves per-socket state to its new instance through `snapshot` and `restore`.
- A device behind a route that crashes loses its per-socket state when it resets: its calls in flight fail, which closes their sockets with 1011, and its new instance doesn't know the other sockets. A restart starts without that state too. `httpHandler` closes a socket it doesn't know with 1011 at the socket's next message, and the panel closes the others through `sockets`, as [WebSocket](#websocket) describes.
- Replacing the panel itself follows [the panels decision](261118_070617-panels-as-devices.md#hot-swaps): HTTP keeps serving, with the limits that decision states for a hot swap. Its WebSockets close with 1012 once the messages in flight on them have been handled, at the latest at the end of its drain, and clients must reconnect, which a browser's `WebSocket` doesn't do by itself.
- Editing the routes, or any other field of the panel's configuration, replaces the panel, since its configuration and needs change. A new port moves its listener without a restart of the rack.

### Certificates that change

- At start, the panel loads its certificate files. A pair that doesn't load fails its `powerOn`.
- Every `certificateCheck`, 60 s by default, the panel reads the files and compares their content with what it loaded.
- When a pair changed and loads, the panel replaces the certificates with the listener's `setTls()`. New connections get the new certificate, and connections opened under the old one keep working, as measured on every system.
- A pair that changed and doesn't load, such as a key that doesn't match its certificate, or a file written halfway, leaves the old pair in place. The panel checks it again at the next check, and logs an error if it still doesn't load, once until its files change again. Bun refuses such pairs when the new server binds, as the panels decision measured on Linux.
- With SNI, the panel checks each pair on its own. Since `setTls()` replaces the list as a whole, the panel builds the new list from the pairs that changed and load, and the old versions of the others. The first pair stays the one that unknown names get.
- A tool that renews a pair writes its two files one after the other. A check between the two writes finds a certificate and a key that don't match: the panel keeps the old pair without an error, and the next check loads the new one.
- `status()` shows each certificate's subject and expiry date, in the entry of the panel's listener.
- The README advises tools that renew certificates to write each file under a temporary name and rename it, so that the panel never reads half a file. Renaming doesn't make the two files change together; the check after the second write takes the pair.

### The connector

- `http/v1` becomes `http/v2`, a new major version, since its bodies and members change:

  | Member | Kind | Carries |
  |---|---|---|
  | `handle` | RPC | `{ method, url, headers, params, body, socket? }` to `{ status, headers, body }`, or to `{ upgrade: { protocol?, headers? } }` for an upgrade request, which alone carries `socket` |
  | `opened` | RPC | `{ socket }`, when a WebSocket opened |
  | `message` | RPC | `{ socket, data }`, a message from the client, as a string or bytes |
  | `closed` | RPC | `{ socket, code, reason }`, when a WebSocket closed |
  | `sockets` | RPC | `{ instance, open }`, every 30 s, to `{ unknown }`, as [WebSocket](#websocket) describes |
  | `send` | event | `{ socket, data }`, to one socket id or a list |
  | `close` | event | `{ socket, code?, reason? }`, to one socket id or a list |

- Headers stay arrays of `[name, value]` pairs, so duplicate headers survive. A body is `null`, bytes, or a stream, in both directions.
- `Http`, the `http/v2` connector, and `httpHandler` move from `rack42u` to `rack42u/std`, beside the panel, so that the core keeps only mechanisms, such as `ctx.serve` and `stream()`, and no logic for HTTP applications.
- `httpHandler(fetch)` keeps working for HTTP. With WebSocket handlers it takes the port's events too:

  ```ts
  powerOn: (ctx) => ({
    http: httpHandler(
      {
        fetch(request, server) {
          const origin = request.headers.get("origin");
          if (origin !== null && origin !== "https://app.example") {
            return new Response("forbidden", { status: 403 });
          }
          if (server.upgrade(request, { protocol: "chat" })) return;
          return new Response("hello");
        },
        websocket: {
          open(ws) {
            ws.send("welcome");
          },
          message(ws, data) {
            ws.send(data);
          },
          close(ws, code, reason) {},
        },
      },
      ctx.emit.http, // what the sockets send travels as this port's events
    ),
  }),
  ```

  - `server.upgrade(request, options?)` takes Bun's `headers` and `data`, and `protocol`, the subprotocol it accepts, which Bun's own `upgrade()` doesn't have. As in Bun, it returns `true`, and the handler then returns nothing.
  - Its socket objects have `send()` and `close()`, which emit the port's `send` and `close` events, and `data` for per-socket state.
  - `handler.sockets()` lists its sockets with their data, as `{ socket, data }[]`, for the device's `snapshot`, and `handler.restore(list)` takes them back in `restore`, so a device keeps them across a hot swap.
  - It answers the panel's `sockets` calls itself.
  - A request body reaches `fetch` as the standard `request.body` stream, and a `Response` with a `ReadableStream` body streams to the client.
  - An upgrade request that `fetch` doesn't accept gets the response `fetch` returns. So a device accepts WebSockets only where its code calls `upgrade()`.

### Needs from configuration

- A device API change: a device's `needs` may be a function of its validated configuration.

  ```ts
  export default device({
    model: "http-panel",
    config: PanelConfig,
    needs: (config) => routeNeeds(config.routes), // one need per distinct route target
    // ...
  });
  ```

- The Worker host computes the needs at boot, once it has validated the configuration, and reports them in the FRU data.
- A need may name the port it is wired to, with `patched(connector, address)`, a new export of `rack42u`: `{ orders_http: patched(Http, "orders.http") }`.
  - In a manifest that places devices by hand, the rack treats it as a patch from that need to that address.
  - In a scanned rack, the address names a model. The plan wires the need to the port that the address names on that model's shared instance, and pulls the model in.
  - A patch, or a `use` entry keyed `<model>.<need>`, for the same need wins. A `use` entry keyed by a connector id doesn't change a need that `patched()` wires.
- The panel's needs are the distinct addresses its routes name, one shared `http/v2` need each. A need is named after its address with `.` and `-` replaced by `_`, such as `orders_http`, and with a `_` in front when the address starts with a digit, such as `_2fa_http`, since need names are identifiers. Two addresses that give one name fail the panel's configuration with `RACK_INVALID_CONFIG`.
- In a scanned rack, the rack describes such firmware with the configuration of each instance that the plan gives it.
- So the rules for routes become the rules for wired needs, which exist already:
  - The panel sits above every device it routes to. In a manifest that places devices by hand, a route to a device that isn't below the panel fails with `RACK_MANIFEST`, as a patch against the gravity rule does. A scanned rack's plan places the panel above its targets by itself.
  - A route to an unknown device, or to a port that isn't `http/v2`, fails with `RACK_MANIFEST`, as such a patch does.
  - In a scanned rack, the panel's routes pull in the models they name. This replaces the rule that a route makes a model a root. The panel itself must be listed in `roots`, and `rack plan` lists a panel left out of them as unused.
  - A swap that removes a routed port, or changes its connector, is refused or handled as a contract change, as for any wired port. A routed device can't be unplugged while the panel needs it.

### Manifests

- The `panel` section of rack manifests goes away. A manifest mounts `httpPanel()` in a slot, or lists it in a scanned rack's `devices`:

  ```ts
  // Placed by hand: the panel sits above the devices it routes to.
  export default rack("hello", {
    slots: {
      1: memkv(),
      3: slot("./devices/greeter.ts", { config: { prefix: "Hello," } }),
      4: slot("./devices/web.ts"),
      5: httpPanel({ port: 3000, routes: { "/greet": "web.http" } }),
    },
  });

  // Scanned: the panel is a root, and its routes pull in the models they name.
  export default rack("app", {
    devices: [
      "./devices",
      sqlite({ path: "data/app.db" }),
      httpPanel({ port: 3000, routes: { "/api/*": "a.http" } }),
    ],
    roots: ["http-panel", "b", "c"],
  });
  ```

- A manifest with a `panel` section fails with `RACK_MANIFEST`, with a message that points to `httpPanel()`.
- This breaks existing manifests and `http/v1` devices, so the next version is 0.4.0. Earlier breaking changes went into a minor version too, in 0.2.0, as versions before 1.0.0 allow.

### Failure modes

| Failure | Outcome |
|---|---|
| A body over `maxBodySize` | 413 |
| A request for another host, on a loopback `hostname` | 403 |
| No route matches | 404 |
| The device's call fails, or times out | 502, 503, or 504, as [Requests](#requests) lists |
| The client stops sending its body | 408 after `idleTimeout` |
| A response body stalls | the response ends abruptly after `idleTimeout` |
| The client stops reading its response | the response ends abruptly once nothing has moved for `idleTimeout` |
| The client goes away | the call and its streams are cancelled |
| The device refuses an upgrade | its response, such as 401 or 403 |
| `maxConnections` WebSockets are open | upgrades get 503; the log warns once when this starts and once when it ends |
| A client's message over `maxMessageSize` | the WebSocket closes with 1009 |
| A client that reads too slowly | the WebSocket closes with 1013 |
| A device slower than a socket's client | the socket is paused at 16 unfinished messages |
| A message call fails | the socket closes with 1013 or 1011 |
| An event for a socket the panel no longer has | the panel ignores it |
| The device behind a route resets or restarts | its sockets close with 1011, at their next message or through `sockets` within about a minute |
| A certificate pair that still doesn't load at the next check | an error in the log; the old pair stays |
| The panel crashes, or a watchdog bites | its connections end, and its WebSockets close with 1001 at the client, as measured on Linux; its reset listens on the same port; connections are refused meanwhile; the devices behind it run their `close` handlers for its sockets with 1006 within about 90 s |

### Bounds

| What | Bound |
|---|---|
| A request body | `maxBodySize`, 1 MiB by default |
| Requests in flight per route target | the need's unfinished calls, `queueLimit`, 10 000 by default |
| The wait for a response head | `callTimeout`, 30 s by default, from the end of the request body |
| A body without progress, and an idle connection | `idleTimeout`, 10 s by default |
| Open WebSockets | `maxConnections`, 10 000 by default |
| A client's WebSocket message | `maxMessageSize`, 1 MiB by default |
| Message calls unfinished per socket | 16 |
| Messages held after a pause | those Bun had read before it |
| Bytes unsent per socket | 1 MiB |
| Checks of the certificate files | one every `certificateCheck`, 60 s by default |
| Checks of WebSockets that one side lost | one `sockets` call every 30 s per route target where the panel has WebSockets |

- The panel doesn't bound the number of HTTP connections itself. The system's limit on open files does, and `idleTimeout` closes idle ones.
- A download to a slow client holds, besides its stream's window, what Bun and the system buffer ahead of the client. In the download probe of the streams decision, on Linux, that was about 4 MiB.

### Observation

- The panel's needs have counters per route target, as every need has: `calls`, `ok`, `errors` by code, `timeMs`, and the `streams` counters of the streams decision.
- The entry of the panel's listener in `status()` shows its URL, its certificates with their expiry dates, its requests in flight, and its open WebSockets.
- The log has the listener's entries of the panels decision, the panel's certificate replacements and rejections, and the start and end of refusing upgrades at `maxConnections`.
- What the panel answers without a call that reached a device shows in no counter: 404, 403 for another host, upgrades refused at `maxConnections`, and 408 and 413 for bodies that never reached one. When a body fails after its call started, the call counts under its error code. A later decision on counters that devices define can add the rest.

### Tests

The tests run on Linux, macOS, and Windows:

- Every status of [Requests](#requests): 413 with a declared length and chunked, 404, 502, 503 for a faulted device and at `queueLimit`, 504 for a late head and for a device that stops reading, and 408 for a client that stops sending, both a body sent as bytes and one that streams.
- Streams: a large upload and a large download through the panel, with the bytes in flight bounded; server-sent events that arrive as they are sent; a client that goes away cancels the device's stream.
- WebSocket: an upgrade refused and one accepted with a subprotocol; text and binary messages both ways; a message over `maxMessageSize`; a client that doesn't read, closed with 1013; upgrades at `maxConnections`; a socket paused under a slow device, with the messages that Bun had read before the pause handled in order; a failed message call; several panels on one port of a device; events for a socket that closed, ignored.
- TLS: SNI, with one pair replaced while another doesn't load; a certificate replaced while connections stay open; a bad pair rejected while the old one serves, with an error at the second check; a renewal that writes the certificate and the key one after the other, without an error.
- Swaps: of the device behind a route with WebSockets open, keeping them and their state through `handler.sockets()` and `handler.restore()`; of the panel, keeping HTTP serving and closing WebSockets with 1012; a reset and a restart of the device behind a route, whose sockets close with 1011, also those that never send.
- Sockets that one side lost: after a panel crash, the device runs its `close` handler for each of the panel's sockets with 1006; a socket that opens while a `sockets` call is under way stays open.
- Hosts: a panel on loopback answers 403 for another host and serves `localhost` and the names in `allowedHosts`.
- Configuration: a hand-placed rack with a route to a device above the panel fails; a scanned rack pulls in the routed models; edited routes and a new port replace the panel; a manifest with `panel` fails with `RACK_MANIFEST`.
- The counters per route target.

## Alternatives

- **Keep routes in the manifest's `panel` section, and let the rack hand them to the panel device**: manifests wouldn't break. But the rack would keep special code for one device, and a rack couldn't mount two panels.
- **Static needs, with a patch in the manifest for each route target**: no device API change. But routes and patches would repeat each other, and a forgotten patch would leave a route without a target.
- **A separate WebSocket panel or connector**: the user asked for WebSocket as part of the HTTP panel.
- **Send client messages to the device as events**: no call per message. But events flow from a provider up to its consumers, so a panel above the device can't emit them to it. Calls also carry backpressure, which events lack.
- **Let the device send to sockets by calling the panel**: delivery would be confirmed. But the device sits below the panel, and the gravity rule forbids depending on a device above.
- **Number each socket's sends, so that the panel can close a socket whose sends have a gap**: no message would go missing unseen. But every send and every broadcast would carry counters per socket, for a drop that happens only when the panel is `queueLimit` events behind.
- **Replace the certificates with `server.reload({ tls })`**: no second server. But it doesn't change the certificate, as measured on every system.
- **Watch the certificate files instead of checking them on a timer**: a change would show sooner. But file watching behaves differently across systems and tools, which often write in several steps, while a fixed interval behaves the same everywhere and bounds the work.
- **Terminate TLS outside the rack, in a reverse proxy**: it still works, with the panel on `127.0.0.1` behind the proxy. But the user asked for certificates the rack loads itself.
- **Keep `http/v1` beside `http/v2`**: existing devices would keep working. But the panel would speak two connectors, and `http/v1` copies bodies in full.

## Impact

- Breaking changes, so the next version is 0.4.0:
  - The `panel` section of manifests goes away, with `HttpPanelSpec` and `PanelSpec`.
  - `http/v1` becomes `http/v2`, and devices that implement it by hand change.
  - `Http` and `httpHandler` move to `rack42u/std`, so device files change their import.
  - Calls from the panel are calls between devices, so they leave `metrics().outside`, as the panels decision says.
- The costs:
  - Each request crosses one thread boundary in each direction, as today, from the panel's Worker instead of the main thread.
  - A body over 64 KiB, or without a declared length, travels as a stream, at a message per chunk plus credit.
  - A rack with a panel has one more Worker, about 3 MB according to the [hot swap evidence](261112_035943-hot-swap.md#evidence).
- How the accepted decisions this one affects are handled once it is accepted:
  - [Device and rack API](261112_043034-device-api.md#panel-http): its "Panel HTTP" section, the `panel` field of its manifest, and the panel that `start()` opens give way to this decision. `needs` may be a function, and `patched()` joins `own()`. The decision is broad, so it stays, with this note, and this decision comes first where they differ.
  - [P0 standard connectors, rack handle shapes, and test fixtures](261115_222025-p0-api-details.md#error-codes): its rules for panel routes, unknown routes at assembly, routed ports in swaps, and routed devices in unplugs, become the rules for wired needs. It stays, with this note. The panels decision covers its log entry.
  - [P0 scope, repository layout, and toolchain on Bun 1.4.4](261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#toolchain-and-dependencies): it records P0's scope, which stays as history. In its list of the connectors that valibot writes, `http/v1` becomes `http/v2`, as an implementation fact.
  - [Backplane protocol with direct links between devices](261116_024226-backplane-links.md#wiring-and-routing): calls from outside the rack are only `rack.call()`'s, and routed ports are wired ports. It stays, with this note.
  - [Automatic assembly from scanned device files](261116_233919-automatic-assembly.md#scanned-manifests): the rule that a panel route makes a model a root gives way to the panel's needs, and its example manifest changes. It stays, with this note, and this decision comes first where they differ.
  - [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan): an edited panel is a device whose configuration changed, which the rack replaces, instead of routes the rack sets. It stays, with this note.
  - [Bounded backlogs instead of a breaker and thermal](261117_063228-bounded-backlogs.md#bounded-calls): the panel's calls are bounded as a need's calls, and the panel still answers `RACK_OVERLOADED` with 503. It stays, with this note.
  - [Counters for calls from outside the rack](261117_185225-outside-call-metrics.md#decision), [Rack runtime architecture](261112_035942-rack-architecture.md#basic-units), and [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-rack-owns-external-connections): the panels decision handles them.
  - [When a test may change](261118_011457-changing-tests.md#decision): the tests of the main-thread panel change under this decision once it is accepted, as that decision allows.
- `AGENTS.md`: the repository structure loses `panel.ts` and the `http/v1` connector and gains the panel device under `src/std/`. The current state lists P3, and no longer says that the WebSocket panel still needs a decision.
- The README: the "HTTP panel" section moves under "Standard devices", with WebSocket, TLS, and the limits. The hello app and the scanned manifest change, "Restart needed" loses the panel port, and "Not supported yet" loses the WebSocket panel and streaming bodies. It calls out what a device behind a panel on loopback still checks itself: the `Origin` of WebSocket upgrades, and requests that change state, which any web page can send to `127.0.0.1`.
- `examples/shop-api` mounts `httpPanel()` in a slot above `orders`.
- Follow-up work once this decision is accepted, together with the panels and streams decisions:
  - The device in `src/std/`, with its factory, `http/v2`, and `httpHandler` exported from `src/std/index.ts`, and no longer from `src/index.ts`.
  - Needs as a function and `patched()` in `src/device.ts`, the FRU data in `src/worker.ts` and `src/protocol.ts`, and describing firmware with its configuration in `src/rack.ts`.
  - The removal of `src/panel.ts` and of the panel's code in `src/rack.ts`, `src/manifest.ts`, `src/index.ts`, and `src/metrics.ts`, and of `panel` as a caller of calls from outside the rack in `src/protocol.ts`.
  - The tests above, in a new test file for the panel. The tests that mount `panel.http` today move to the device: `test/panel.test.ts`, `test/swap.test.ts`, `test/backlogs.test.ts`, `test/metrics.test.ts`, `test/rack.test.ts`, `test/changes.test.ts`, `test/cli.test.ts`, `test/manifest.test.ts`, `test/example.test.ts`, `test/readme.test.ts`, and the helpers in `test/fixtures/app.ts` that wait for `panel http listening`. The fixture device `test/fixtures/devices/web.ts` and the example's `examples/shop-api/devices/orders.ts` move to `http/v2`.
  - A benchmark of the panel device, with bodies as bytes and as streams, recorded in `## Implementation`.
  - `package.json` at 0.4.0, in a commit of its own, before the tag.

## Implementation

- **Modules.**
  - `src/std/http.ts` holds `http/v2` and `httpHandler`, `src/std/http-panel.ts` is the device, and `src/std/index.ts` exports them with `httpPanel()`.
  - Needs from configuration span several modules:
    - `src/device.ts`: `needs` as a function, `patched()`, `isPatched()`, and `checkNeeds()`.
    - `src/worker.ts`: computes the needs at boot and when it describes firmware.
    - `src/protocol.ts`: `NeedInfo.patched`, `Fru.computedNeeds`, and `DescribeRequest.config`.
    - `src/rack.ts`: describes firmware with its configuration, and treats the address of a need that `patched()` wires as that need's patch.
    - `src/plan.ts`: wires such a need in the planner, after a `use` entry for the need and before one for its connector.
  - The main-thread panel's code is gone from `src/rack.ts`, `src/manifest.ts`, `src/index.ts`, and `src/metrics.ts`, and `src/panel.ts` and `src/http.ts` are deleted.
- **Names.** The decision's `handler.sockets()` is `handler.list()`, since `sockets` is also the name of the connector member that the same object implements.
- **Details the decision left open.**
  - Request bodies:
    - A body of a declared length up to `streamThreshold` is read with `request.bytes()`, under one timer for the whole body, as [A configurable stream threshold](261118_165318-stream-threshold.md#bodies-sent-whole) decides.
    - A longer one goes through a wrapper stream, whose reads time out after `idleTimeout`.
  - Who stalled: the stream to the device times out at both of its ends after the same `idleTimeout`, so the two timeouts would race. When the stream is cancelled with `RACK_TIMEOUT`, the panel looks at what it was waiting for:
    - for the client's bytes, it answers 408;
    - for the device to take them, it gives up the call and answers 504.
  - Response bodies: `httpHandler` returns bytes when the body ends within its `streamThreshold`, and each read settles within four microtask turns or before a `setImmediate`, which ends the event loop's turn. Otherwise it returns a stream that starts with the chunks read so far.
  - Bun's timer, which the panel lifts for each exchange, is set back once the response ends. That also happens when the device's stream fails while Bun isn't reading, so Bun closes the connection of a client that stopped reading.
  - Certificates:
    - The panel checks that a changed pair loads with `X509Certificate.checkPrivateKey()` before it calls `setTls()`.
    - It resolves paths with `resolve(baseDir, path)`, so absolute paths work too.
  - Sockets lost after a panel crash:
    - A panel's reset instance calls `sockets` only where it has WebSockets. So `httpHandler` checks for silent panel instances at every call it gets, of any member, and a device forgets the sockets of a crashed panel at its first call after 90 s.
    - Any call that names a socket of a panel instance counts as a call from that instance.
  - The FRU data says whether the needs come from the configuration, in `computedNeeds`. So the rack describes such firmware once per configuration, and any other firmware once.
  - In a scanned rack, the plan describes a model with the configuration of its shared instance: the model's entry in `config`, or else its spec's. At boot, an own copy whose configuration gives other needs is wired by the rules of a rack placed by hand.
  - The WebSocket defaults, 1 MiB and 10 000, live in the panel's configuration schema. The module exports the schema and `SYNC_MS` for the tests of the defaults.
  - Test hook: `RACK42U_TEST_PANEL_SYNC_MS` shortens the 30 s between the panel's checks, and with them the 90 s of `httpHandler`, so that tests don't wait. A Worker copies it as it starts.
- **Found on the way:** the `bytesSent` stream counter stayed 0. The sending end read a piece's size after the post that transferred, and so emptied, its buffer. The fix has a commit of its own.
- **Benchmark.**
  - Setup:
    - Measured on 2026-11-18 on the local machine: Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores, Bun 1.4.4, with probe scripts outside the repository.
    - The load was the one [Evidence](#evidence) used: 3 client processes, each with 64 keep-alive clients, 3 s per scenario. The table gives the median of 3 runs.
    - The device behind the panel answered with `httpHandler`. The main-thread panel ran at `f7e772c`, with the same device on `http/v1`, which copied bodies in full.

  | Scenario | Panel device | Main-thread panel |
  |---|---:|---:|
  | `GET`, a 2-byte response | 45,760 requests/s, 3.89 ms | 54,244 requests/s, 3.22 ms |
  | `POST` of 1 KiB, as bytes | 31,915 requests/s, 5.59 ms | 46,797 requests/s, 3.69 ms |
  | `POST` of 64 KiB, as bytes | 810 MiB/s, 14.66 ms | 1,170 MiB/s, 9.61 ms |
  | `POST` of 256 KiB, as a stream | 1,426 MiB/s, 32.67 ms | 1,772 MiB/s, 26.52 ms, copied |
  | `GET` of a 1 MiB response, as a stream | 896 MiB/s, 215.76 ms | 1,867 MiB/s, 107.36 ms, copied |

  - The latencies are medians.
  - Where the time goes, from probes of one run each:
    - `request.signal`, which Bun builds for each request that reads it: about 12% of the small `GET`s.
    - Reading a small body with a reader and a timer instead of `request.bytes()`: 12% at 1 KiB and 30% at 64 KiB. `request.bytes()` can only bound the whole body, not the idle time that [Requests](#requests) bounds for a body sent as bytes, so the panel keeps the reader.
    - The `setImmediate` before each handler, `listener.timeout()`, and reading a response with a reader instead of `arrayBuffer()`: nothing measurable.
  - A stream copies each chunk once and waits for credit per window, and Bun writes a streamed response in chunked encoding. So a 1 MiB response that is complete at once moves at half the rate of a copy, since the decision streams any response body over 64 KiB.
  - [A configurable stream threshold](261118_165318-stream-threshold.md#implementation) records the benchmark after its changes, which made the threshold an option and the panel faster.
- **Tests.**
  - `test/http-panel.test.ts`, and `test/needs.test.ts` with the fixture `devices/picker.ts`.
  - New cases in `test/plan.test.ts`, and the cases that moved to the device in `test/backlogs.test.ts`, `test/changes.test.ts`, `test/cli.test.ts`, `test/manifest.test.ts`, `test/metrics.test.ts`, `test/rack.test.ts`, and `test/swap.test.ts`. The case of `test/changes.test.ts` in which a new panel port needed a restart went away, since such a change now replaces the panel, as `test/http-panel.test.ts` tests.
  - The fixtures:
    - `devices/web.ts`, now on `http/v2`;
    - `devices/chat.ts`, for WebSockets;
    - `devices/crashing-panel.ts`, which wraps the panel with a port that crashes it;
    - `test/fixtures/net.ts`;
    - a third test certificate, `certs/three.crt` and `certs/three.key`.

## Confirmation

- The user accepted this decision on 2026-11-18. The user asked for a listen address and port, loopback by default; a declared request body limit as a configuration item; WebSocket as part of the HTTP panel; and TLS certificates that load without a restart.
- The Agent settled the details the user left to it, such as the `http-panel` name, `Http` and `httpHandler` in `rack42u/std`, and the `sockets` checks of WebSockets that one side lost.
