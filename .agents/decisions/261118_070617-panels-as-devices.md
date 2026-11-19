# Decision: Panels as devices, with listeners that survive swaps

Status: accepted

## Background

- The HTTP panel is the rack's only external port for application traffic. `start()` in `src/rack.ts` opens it with `openHttpPanel` from `src/panel.ts` once every device is online. It is a `Bun.serve` server on the rack's main thread.
- The manifest configures it with `panel.http`, which has only `port` and `routes`:
  - It passes no `hostname`, so it listens on every interface. Bun documents the default as `0.0.0.0`, and on Linux `ss -ltn` showed `*:<port>`.
  - It passes no `maxRequestBodySize`, so Bun's undeclared default of 128 MB applies. It reads each request body in full before it forwards the request.
  - It passes no `idleTimeout` and no `tls`, so Bun's 10 s idle timeout applies, and there is no TLS.
  - An edited manifest replaces its routes through `server.reload()`. A changed port needs a restart of the rack.
- It forwards each request as a call from outside the rack, like `rack.call()`: `Backplane.call` with the caller `panel`.
- Three accepted texts put external connections on the main thread:
  - Hard constraint 5 of `AGENTS.md`: "The panel owns external connections; devices provide only the handling logic."
  - The Panel entry of [Rack runtime architecture](261112_035942-rack-architecture.md#basic-units): "The rack owns the ports, and devices supply only the handling logic."
  - [The rack owns external connections](261112_035943-hot-swap.md#the-rack-owns-external-connections) in the hot swap decision: "The panel (`Bun.serve`) is owned by the rack main thread." It also plans a WebSocket handler there that forwards messages to the installed device. That handler was never built: the README lists a WebSocket panel as not supported yet.
- [Position the project as an application-agnostic base component framework](261112_035941-project-scope.md#decision) already lists external ports among the standard devices the framework provides.
- On 2026-11-18 the user asked for, in P3:
  - a listen address and port for the HTTP panel, loopback by default, and a declared request body limit;
  - WebSocket support, as part of the HTTP panel rather than a separate panel;
  - devices that can have their own HTTP panel, and network components such as the HTTP panel built as devices, "to separate connection management and make things more flexible";
  - TLS certificates that load while the rack runs, so that a certificate that expires doesn't need a restart.
- On the main thread, the panel shares one event loop with the work that supervises the rack: power sequencing, the watchdogs' checks, and the management endpoint. Untrusted network input, TLS handshakes, and body parsing run there. Nothing watches that event loop, and a fault in that code affects the whole rack.
- A device can call `Bun.serve` in its own Worker today, but the rack knows nothing of it:
  - A hot swap fails when the new instance binds the port while the old one still holds it. A device that closes its server before the new instance binds refuses connections in between, as [Evidence](#evidence) measured.
  - Two devices on one port fail only with Bun's error, at whatever moment the second one binds.
  - `status()` shows no listener, certificate, or load.
- Goals, as [Design goals and principles](261117_062916-design-principles.md#goals) defines them:
  - reliability, since external connections leave the thread that supervises the rack, keep serving through hot swaps within the limits that [Hot swaps](#hot-swaps) states, and are bound by declared limits;
  - maintainability, since a panel is a device that can be changed and tested on its own, and the rack loses its special case for HTTP;
  - observability, since the rack reports every listener, its certificates, and its load;
  - extensibility, since any device can serve HTTP and WebSocket, and builders add panels as devices.

### Evidence

Measured on 2026-11-18 with Bun 1.4.4, revision `38afee6c8`. The probe scripts are not in the repository.

- **Machines.**
  - "Linux, local": Ubuntu 26.04.1 LTS, Linux 7.0.0-43-generic, x64, 32 cores.
  - CI: one run of a probe workflow on GitHub Actions, run 44325430359, from a branch that was deleted afterward. The runners were `ubuntu-latest` (Linux 7.0.0-1019-azure, x64, 2 CPUs), `macos-latest` (Darwin 25.6.0, arm64, 3 CPUs), and `windows-latest` (Windows Server 2025, 10.0.26100, x64, 2 CPUs).
  - The CI probe ran each step in its own process, and bound first listeners on a port known to be free. Its servers held their requests in flight until the probe released them. It also ran once on the local machine. Every measurement ran once per system, so small counts can vary between runs.
- **Sockets in a Worker** (Linux, local): `Bun.serve`, `Bun.listen`, `Bun.connect`, and `Bun.udpSocket` all worked inside a Worker.
- **Sharing a port** (CI, every system):
  - A second Worker could bind a port that a first Worker held, when both asked for `reusePort`. A second process could too.
  - A bind without `reusePort` on either side failed with `EADDRINUSE`, in either order, between processes and between Workers of one process.
- **Who gets new connections while two listeners share a port.** "Old" is the listener that bound first:

  | New connections | Linux, local | Linux, CI | macOS | Windows |
  |---|---|---|---|---|
  | 200, two Workers | 102 old, 98 new | 103 old, 97 new | 200 new | 200 old |
  | 20 over TLS, two servers in one thread | 12 old, 8 new | 10 old, 10 new | 20 new | 20 old |
  | 100, two processes | 48 old, 52 new | 51 old, 49 new | 100 new | 100 old |

- **Handing a port over with `stop()`.** The probe bound a second listener with `reusePort`, then called `stop()` on the first, while a loop sent one request per new connection:

  | | Linux, local | Linux, CI | macOS | Windows |
  |---|---|---|---|---|
  | Loop requests during the stop | 4,433 | 1,388 | 1,297 | 1,016 |
  | Of them failed | 0 | 0 | 0 | 0 |
  | Requests in flight on the old listener, answered | 10 of 10 | 10 of 10 | 10 of 10 | 10 of 10 |
  | New connections afterward that reached the new listener | 50 of 50 | 50 of 50 | 50 of 50 | 50 of 50 |
  | `stop()` resolved after the call, once the probe closed a WebSocket | 303 ms | 315 ms | 304 ms | 318 ms |

  - On every system, a WebSocket opened on the old listener still echoed after its `stop()`. `stop()` resolved only once the probe closed that WebSocket, so its time is the probe's, not the system's.
  - 32 keep-alive clients in one thread sent requests while a second server took the port over and the first one stopped. None failed on any system: 55,926 requests locally, 19,886 on Linux CI, 26,035 on macOS, and 23,393 on Windows. The first server's `stop()` resolved in 0.4 ms, 0.6 ms, 0.7 ms, and 3.5 ms.
  - An earlier local probe, whose requests in flight took a fixed 300 ms instead of being held, gave the same outcome: 4,212 requests on new connections and 60,694 on keep-alive connections, none failed.
  - Every client in these probes was Bun's `fetch`. A client that sends a request on an idle keep-alive connection at the moment the old listener closes it sees the connection close. HTTP clients commonly retry such a request when its method is idempotent, as [RFC 9110, section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2) allows. The probes don't show whether Bun's `fetch` retried, and other clients were not tried.
  - While the CI probe was developed, 2 of 6 local runs of the same steps had 1 `ECONNRESET` among about 4,400 requests on new connections. Most likely Linux had queued that connection for the listener that stopped. The final local run and the CI run had none. Linux's `net.ipv4.tcp_migrate_req`, 0 on the local machine, moves such connections to another listener of the port. It was not tried.
- **Stopping first, then binding without `reusePort`:**
  - The new bind worked on the first try on every system, 1 to 2.5 ms after `stop()`. A listener that never had a connection could be bound again 1.1 to 3 ms after its `stop()`.
  - Of the requests that a loop sent on new connections before, during, and after that gap, 8 of 1,188 failed locally and 8 of 403 on Linux CI, with `ECONNREFUSED`; 1 of 357 on macOS, with `ECONNRESET`; 4 of 293 on Windows, 3 with `ECONNREFUSED` and 1 with `ECONNRESET`.
  - The earlier local probe measured a gap of 2.3 ms, and 65 of the 1,243 requests of its loop failed.
- **A bind without `reusePort` as a check for other processes** (CI):
  - On every system, it failed with `EADDRINUSE` while another process held the same address, with or without `reusePort`.
  - Without `reusePort` on either side, Linux and Windows also refused binds of `0.0.0.0` and of `127.0.0.1` on one port, in either order. macOS allowed both, and its `127.0.0.1` listener got every loopback connection, whichever bound first.
- **TLS** (CI, every system):
  - `server.reload({ tls, fetch })` changed the handler but not the certificate that new connections got.
  - A second server with a new certificate on the same port, with `reusePort`, then `stop()` of the first: 20 of 20 new connections got the new certificate. A WebSocket opened under the old certificate kept working.
  - Given a list of certificates with `serverName`, a server picked one by SNI and gave unknown names the first one.
  - On the local machine only, `Bun.serve` refused to bind with a key that didn't match its certificate, with a certificate or a key cut in half, with an empty certificate, and with an SNI list in which one pair didn't match. Each time it threw an OpenSSL error, such as `KEY_VALUES_MISMATCH` or `BAD_END_LINE`.
- **WebSocket topics** (Linux, local): a WebSocket subscribed to a topic on one server got nothing that `ws.publish()` or `server.publish()` sent to that topic on a second server in the same thread.
- **Request body limit** (CI, every system): with `maxRequestBodySize` at 1 MiB, Bun answered a 4 MiB body with 413 and an empty body, both with `content-length` and chunked. A 512 KiB body got 200. On macOS, curl 8.7.1 also exited with code 56, "connection reset by peer", because Bun closed the connection while curl was still sending.
- **HTTP idle timeout** (Linux, local):
  - Bun refused an `idleTimeout` above 255 s, "Bun.serve expects idleTimeout to be 255 or less", and accepted 0, which turns it off.
  - With `idleTimeout` at 4 s, traffic during a request didn't extend it:
    - A handler that took 3 s was answered. Handlers that took 6 s and 9 s were reset after 5 s and 4 s.
    - A response stream with one chunk every 3 s was reset at 4 s.
    - In two runs, a 16 MiB download at 2 MiB/s was cut after 11.4 and 12.3 MiB, at 5.5 and 6 s, and a 16 MiB upload at 2 MiB/s was reset after about 9 MiB, at 4 to 4.5 s.
  - An idle keep-alive connection was closed 4 s after its request.
  - Bun applies the timeout in steps of 4 s. With `idleTimeout` at 1, 2, and 4 s, an idle keep-alive connection closed after 4 s, and with 10 s after 12 s.
  - `server.timeout(request, 0)` let a stream with 6 s gaps finish after 24 s.
  - The change outlasted the request: after `server.timeout(request, 0)` in a plain request, the idle keep-alive connection stayed open for more than 15 s. Setting `server.timeout(request, 4)` again when a response ended closed the connection 2 s later.
- **Ending a Worker** (Linux, local), after `terminate()` or an uncaught exception, with and without `reusePort`:
  - The Worker closed within 3 ms.
  - Its WebSocket closed at the client with 1001, and its request in flight failed.
  - The port could be bound again without `reusePort` at once, on the first try.
- **A thread stuck in native code** (Linux, local): a Worker served HTTP, then blocked opening a FIFO, and was terminated.
  - 500 ms later, a new connection got no answer within 2 s, and a bind without `reusePort` failed with `EADDRINUSE`.
  - The thread ended 2.5 s after `terminate()`, once the FIFO opened. New connections were then refused, and the port could be bound.
- **Bun's documentation** in `bun-types` 1.4.4:
  - `server.stop()` stops listening and lets requests in flight and WebSockets continue. It closes idle keep-alive connections at once, and the others as soon as their response completes. It resolves once every connection has closed. `stop(true)` closes WebSockets with 1001.
  - `server.reload()` replaces the handlers: "Passing other options such as port or hostname has no effect."
  - `pendingRequests` and `pendingWebSockets` count the requests in flight and the open WebSockets.
  - `ServerWebSocket.pause()` stops reading, so the client sees TCP backpressure, and `resume()` reads again. Messages already read are still delivered, and the WebSocket's idle timeout waits until `resume()`. `getBufferedAmount()` gives the bytes not yet written.
  - WebSocket defaults: `maxPayloadLength` 16 MB, and a larger message closes the connection with 1009; `backpressureLimit` 16 MB, past which `send()` drops the message and returns 0; `closeOnBackpressureLimit` false; `idleTimeout` 120 s, from 0 to 960, where 1 to 7 round up to 8; `sendPings` true.
  - HTTP defaults: `hostname` `0.0.0.0`, `maxRequestBodySize` 128 MB, and `idleTimeout` 10 s.
  - Starting a server allocates about 500 KB.

## Decision

### Panels are devices

- A panel is a device that owns external connections and passes the work to other devices through the backplane. [The standard HTTP panel](261118_071513-http-panel-device.md) is one.
- The rack's main thread holds no external connections, with one exception: the management endpoint of `rack ctl`. It stays as [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#transports) decides, because it must work while devices are faulted or hung.
- Any device may own listeners. A **listener** is an HTTP server, WebSocket included, that a device opens through the rack, so that the rack can hand it over across swaps.

### Listeners

- `DeviceContext` gains `serve(options)`. A device calls it in `powerOn`, and it resolves once the rack has reserved the listener's address:

  ```ts
  powerOn: async (ctx) => {
    const web = await ctx.serve({
      port: ctx.config.port, // 0 picks a free port
      fetch: (request, listener) =>
        listener.upgrade(request) ? undefined : new Response("hello"),
      websocket: { message: (ws, data) => ws.send(data) },
    });
    ctx.log.info("serving", { url: web.url.href });
    return {};
  },
  ```

- The options are the ones of `Bun.serve` that a device needs: `fetch`, `routes`, `error`, the `websocket` handlers, `tls`, `hostname`, `port`, `maxRequestBodySize`, `idleTimeout`, and the WebSocket limits in [Defaults and bounds](#defaults-and-bounds). One more option, `allowedHosts`, is the rack's own.
  - The rack sets `reusePort` itself.
  - It passes no other option of `Bun.serve`, such as `unix`, `development`, `perMessageDeflate`, or the experimental `http2` and `http3`.
- The handlers receive the listener where `Bun.serve` passes its `Server`. It offers `upgrade()`, `timeout()`, and `requestIP()`, which work on whichever server took the request, and `publish()`, below. Listening and stopping belong to the rack.
- The listener that `serve()` resolves with has:
  - `url`, `hostname`, and `port`, final from the start, also for port 0.
  - `reload(handlers)`, which replaces the handlers through `server.reload()`. Open connections and WebSockets stay.
  - `setTls(tls)`, which replaces the certificates through a handover inside the instance. The Worker host binds a second server with the new certificates on the same address, with `reusePort`, then stops the first one from listening. It resolves once the second one listens and the first one no longer does, while the first one still serves the connections opened before.
    - New connections get the new certificates, and connections opened under the old ones keep working, as measured on every system.
    - When the new certificates don't load, `setTls()` rejects with `RACK_INVALID_CONFIG`, and the old ones stay. Bun checks them when the second server binds, as measured on Linux. An SNI list is replaced as a whole, so one pair that doesn't load keeps the whole old list.
    - A listener has at most two servers: the one that listens and, after a `setTls()`, at most one that still serves the connections opened before it. A further `setTls()` first closes that older server: its WebSockets with 1012, "service restart", and its other connections at once. So WebSockets can't keep any number of servers open.
  - `publish(topic, data)`, which publishes to a topic on every server of the listener. Bun's WebSocket topics belong to one server, as measured on Linux, so `ws.publish()` and Bun's own `server.publish()` would miss the WebSockets of the listener's other server after a `setTls()`.
- `serve()` rejects with `RACK_HOOK_FAILED` when the options are invalid, when it is called outside `powerOn`, or when the address can't be reserved, as [Conflicts](#conflicts) describes. Its `data` names the listener as `listener: "<hostname>:<port>"`.
- A `powerOn` in which a `serve()` rejected fails with that error, even if the device caught it, so an instance never runs without a listener it declared. A device that can work on any port declares port 0.
- Invalid options include certificates that don't load. Bun checks them only when a server binds, so the Worker host checks them when `serve()` is called, and the failure comes in `powerOn` instead of when the instance goes into service.
- Devices use `ctx.serve`, not `Bun.serve`, for any HTTP listener they want handed over across swaps.

### Defaults and bounds

| Option | Default | Limit | Beyond the limit |
|---|---|---|---|
| `hostname` | `127.0.0.1` | | |
| `port` | required | 0 to 65 535; 0 picks a free port | |
| `maxRequestBodySize` | 1 MiB | a positive number of bytes | Bun answers 413 |
| `idleTimeout` | 10 s | 1 to 255 s, Bun's range without 0 | the connection closes |
| `websocket.maxPayloadLength` | 1 MiB | a positive number of bytes | Bun closes the WebSocket with 1009 |
| `websocket.idleTimeout` | 120 s, with pings | 8 to 960 s, Bun's range without 0 | the WebSocket closes |
| `websocket.maxBuffered` | 1 MiB | a positive number of bytes | the WebSocket closes with 1013 |
| `allowedHosts` | none | host names | on a loopback `hostname`, a request for any other host gets 403 |

- `idleTimeout` works as Bun implements it, as [Evidence](#evidence) measured on Linux. It closes a keep-alive connection that stays idle that long, and it also bounds each request's whole exchange: traffic doesn't extend it. A device that streams a longer response or takes a longer upload extends it for that request with `listener.timeout(request, seconds)`, and sets it back when the exchange ends, since the change outlasts the request.
- Bun applies `idleTimeout` in steps of 4 s, as measured on Linux. A connection can close a few seconds earlier or later than the value says, and values below 4 s act as 4 s.
- `maxBuffered` bounds the bytes a WebSocket has not yet written to its client. A WebSocket that already has more than that unsent when the device sends to it is closed with 1013, "try again later", instead of growing. So is one whose message Bun drops past its own `backpressureLimit`, which the rack sets above `maxBuffered`.
- A listener on a loopback `hostname`, such as the default `127.0.0.1`, answers 403 to a request whose `Host` header names a host other than its `hostname`, `localhost`, or a name in `allowedHosts`, WebSocket upgrades included. This stops DNS rebinding: a web page whose own domain resolves to `127.0.0.1` sends requests that the browser treats as same-origin, which no CORS rule stops. The management endpoint checks its `Host` the same way, as [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md#the-tcp-endpoint) decides. A listener on any other `hostname` checks nothing, since a proxy in front of it may pass any name.
- An instance has at most 16 listeners, and a listener at most two servers, as `setTls()` describes.
- Requests that a listener takes before its instance is installed wait in the Worker host, at most `queueLimit` of them per listener, 10 000 by default. Beyond that, the Worker host answers 503 at once. While a request waits, the Worker host lifts Bun's timer for it with `timeout(request, 0)`, and sets it back to `idleTimeout` when the request goes to the device. So a long state handover doesn't reset the requests it holds: their wait ends with the swap, which either installs the instance or answers them with 503, as [Hot swaps](#hot-swaps) describes.

### When listeners listen

- `serve()` only reserves the address. The Worker host binds the listener when the rack puts the instance into service, and stops it when the instance leaves service.
- An instance goes into service:
  - at a cold start, once its `activate` succeeds;
  - in a reset or a fallback, once its `activate` succeeds, before the backplane installs it;
  - in a cold swap, a restart, or a group replacement, once its `activate` succeeds, before the backplane installs it;
  - in a hot swap, when the rack holds the slot for the switch, as [Hot swaps](#hot-swaps) describes.
- Until the instance is installed, the requests its listeners take wait in its Worker host. So the device's handlers run only for an instance that is installed and active.
- An instance leaves service:
  - in a hot swap, when the rack holds the slot for the switch that replaces it;
  - in a cold swap, a restart, or a group replacement, when the rack holds its calls to stop it;
  - in an unplug, and at `stop()`, when its power-down starts. `stop()` powers devices down from the top, so a panel stops listening before the devices it calls stop.
- When an instance leaves service:
  - Its listeners stop listening with `server.stop()`. Idle keep-alive connections close at once, and the others once their response completes.
  - Its WebSockets stop reading with `pause()`, so their clients see TCP backpressure.
  - Its drain waits for the requests its listeners are serving until their handlers have answered, as it waits for its calls to return, within `drainTimeout`.
  - A response body that still streams after its handler answered is treated as an open stream of a call, as [Swaps and resets](261118_071155-backplane-streams.md#swaps-and-resets) in the streams decision describes. It may go on until the end of a retirement drain, and it doesn't hold the drain before a state handover or a cold swap. So a long response, such as server-sent events, doesn't hold a hot swap.
  - Its WebSockets close as soon as the messages in flight on them have been handled, and at the latest at the end of its drain: with 1012, "service restart", when another instance of the device takes over, and with 1001, "going away", at an unplug and at `stop()`.
  - Whatever is still open when its drain ends is cut when the rack ends the instance.
- A crash or a watchdog bite ends an instance's listeners with its Worker. As measured on Linux, its WebSockets close with 1001 at the client, its requests in flight fail, and the port is free at once.
- A thread stuck in native code keeps the listeners it hadn't stopped. As measured on Linux, the system still accepts connections to them, and nothing answers. The rack keeps such listeners in its table and lists them with the stuck thread in `status()`. No other instance of the device starts meanwhile, as [Ending instances and stuck threads](261117_185131-ending-instances.md#stuck-threads) decides, so the port stays with the thread until it ends.

### Hot swaps

The swap sequence of [Every device supports hot swap and hot reload](261112_035943-hot-swap.md#the-swap-sequence) gains these steps:

1. The new instance declares its listeners in `powerOn`, and the rack reserves them. Nothing binds while the instance is in standby.
2. The rack holds the slot for the switch: before the old instance drains, when the swap hands over state, or after the new instance's `activate` otherwise. At that moment:
   1. The new instance's listeners bind, with `reusePort`, on the addresses they declared.
   2. Then the old instance's listeners stop, and the old instance leaves service as above. The rack waits, within `hookTimeout`, for the old instance to confirm that its listeners stopped.
3. The backplane installs the new instance. The requests that waited in its Worker host go to the device, in the order they arrived.
4. The old instance drains and retires.

- If a bind fails in step 2, the swap fails before the old instance stops listening, and the old instance keeps serving.
- An old instance that doesn't confirm the stop within `hookTimeout` can't keep serving. The swap fails, and the rack ends the old instance and recovers the slot as after a watchdog bite, as [Failed hot swaps](261117_185131-ending-instances.md#failed-hot-swaps) decides for an old instance that doesn't answer `deactivate`.
- If the swap fails after the old instance stopped listening:
  - The old instance binds its listeners again, with `reusePort`, while the new instance still holds the port, and its WebSockets that are still open read again.
  - Then the new instance answers the requests it holds with 503 and is ended.
  - An old instance that can't bind again can't keep serving either: the rack ends it, and the slot recovers as after a watchdog bite.
- With a state handover, the old instance stops taking requests before it drains and takes its snapshot. Every request that arrives during the handover waits for the new instance and sees the restored state.
- Every supported system shares a port between two listeners that ask for `reusePort`, within a process and across processes, as the CI run measured. So every hot swap takes this path, and none stops listening before the new listener binds.
- Who gets new connections in the moment both listen differs by system: Linux spreads them, macOS gives them to the newest listener, and Windows to the oldest until it stops. Either way they are answered: the old instance serves the requests it took, and the new one serves its requests once it is installed.
- On Linux, a connection that the system queued for the old listener just before it stopped can be reset, as [Evidence](#evidence) found in 2 of 6 development runs. The README states this limit.
- The probes' clients were Bun's `fetch`. A request sent on an idle keep-alive connection as the old listener closes it can still see the connection close, and HTTP clients retry it only when its method is idempotent. The README states this limit too.

### Cold swaps, restarts, and resets

- In a cold swap, a restart, or a group replacement, the old instance leaves service when the rack holds its calls, and the new instance binds once its `activate` succeeds. In between nothing listens, and connections are refused. The gap lasts from the hold, through the old instance's stop, to the end of the new instance's `activate`.
- In a reset or a fallback, the crashed instance's listeners ended with its Worker. The new instance binds once its `activate` succeeds, and connections are refused until then.
- On every supported system, a bind right after a `stop()` worked on the first try, 1 to 2.5 ms after it, so the new instance gets the same port.

### Port 0

- The first instance of a device that declares port 0 gets a free port when `serve()` reserves it.
- Every later instance of that device gets the same port for the same listener, in swaps, cold swaps, restarts, resets, fallbacks, and rollbacks. The device's address doesn't change while the rack runs.
- The instances' listeners match by declared hostname and port, and by order among the listeners that declare the same pair.
- If another process took the port while no instance of the device held it, as during a cold swap or a reset, the next instance's `serve()` fails as for any other process that holds the address.
- The rack forgets the port when the device is unplugged or the rack stops.

### Conflicts

- The rack's main thread keeps a table of the listeners of every instance, by port.
- Two listeners on one port conflict, whatever their hostnames. macOS lets `0.0.0.0` and `127.0.0.1` both bind one port while Linux and Windows refuse it, so the rack refuses it everywhere.
- The probes bound `127.0.0.1` and `0.0.0.0` only. IPv6 addresses, such as `::1`, follow the same rule in the rack, but how each system handles them was not measured.
- A listener has one `hostname`. So under this rule one instance can't listen on both `127.0.0.1` and `::1` on one port, for clients that resolve `localhost` to `::1` first. Browsers and curl try the next address of a name when a connection is refused, but not every client does. A later decision can let a listener take several hostnames, once IPv6 is measured on every system.
- Two instances share a port only while one replaces the other in a hot swap: a listener of the new instance may declare a port that a listener of the installed instance of the same device holds.
- Any other conflict fails `serve()` with `RACK_HOOK_FAILED`, whose `data` names the listener and its `holder`, the device that holds the port. The hook fails, with the outcome a failed `powerOn` has: a cold start fails, a swap fails and the old instance keeps serving, and a reset counts as a crash.
- **Other processes.** When no instance of the device holds the port, the Worker host binds the address once without `reusePort` and closes it at once, before it reserves it.
  - If that bind fails, `serve()` fails as above, with the system's code in `data.cause`, such as `EADDRINUSE`, and `holder: "another process"` for `EADDRINUSE`. The same bind catches addresses that the system refuses, such as an address the machine doesn't have, or a privileged port on Linux.
  - On every supported system, such a bind fails while another process holds the same address, with or without `reusePort`. So a second rack started by mistake on the same port is refused.
- **Where the check falls short:**
  - On macOS, it doesn't see a process that holds the port on another hostname, such as `0.0.0.0` against the rack's `127.0.0.1`. Both then listen, and the `127.0.0.1` listener gets the loopback connections. The README's macOS note says so.
  - It doesn't run while an instance of the device holds the port, since its own bind would fail then. A program that binds the port with `reusePort` without such a check can join it unseen. The Linux manual page `socket(7)` says that only processes of the same effective user can join a port that way; this was not measured, and who can join on macOS and Windows was not checked.
  - A process can take the port between the check and the bind. The bind then fails, with the outcome of a bind that fails in [Failure modes](#failure-modes).

### Failure modes

| Failure | Detected by | Outcome |
|---|---|---|
| Two devices declare one port | the rack's table, in `serve()` | `RACK_HOOK_FAILED`: the start or the swap fails, or the reset counts as a crash |
| Another process holds the address | the bind without `reusePort`, in `serve()` | the same, with `holder: "another process"` |
| The system refuses the address | the same bind | the same, with the system's code |
| The device catches a `serve()` that rejected | the Worker host | its `powerOn` fails with that error all the same |
| A bind fails when the instance goes into service | the Worker host | `RACK_HOOK_FAILED`, as when `activate` fails: a cold start fails, a hot swap fails and the old instance keeps serving, and a reset counts as a crash |
| A hot swap fails after the old instance stopped listening | the swap | the old instance listens again, or, if it can't, is ended, and the slot recovers as after a watchdog bite; the new one answers the requests it held with 503 |
| More than `queueLimit` requests wait for the install | the Worker host | 503 for each request beyond it |
| The old instance doesn't confirm that its listeners stopped | the rack, after `hookTimeout` | the swap fails; the old instance is ended, and the slot recovers as after a watchdog bite |
| The instance crashes, or a watchdog bites | its Worker's exit | its connections end with it; the reset binds again; connections are refused meanwhile |
| Its thread gets stuck in native code | [Ending instances and stuck threads](261117_185131-ending-instances.md#stuck-threads) | it keeps the listeners it hadn't stopped, which accept and never answer; `status()` lists them; the slot is `faulted` |
| A body over `maxRequestBodySize` | Bun | 413 |
| A WebSocket message over `maxPayloadLength` | Bun | the WebSocket closes with 1009 |
| A client that reads its WebSocket too slowly | the Worker host, at each send | the WebSocket closes with 1013 |
| An idle connection, or an exchange over `idleTimeout` | Bun | the connection closes |
| A request for another host on a loopback listener | the Worker host | 403 |
| Certificates that don't load | `setTls()` | `RACK_INVALID_CONFIG`; the old certificates stay |
| A `setTls()` while an older server still serves connections | the Worker host | that server's WebSockets close with 1012, and its other connections at once |

### Observation

- `SlotStatus` gains `listeners`, one entry per listener of the installed instance, and `StuckThread` gains the same for the listeners a stuck thread keeps:

  ```ts
  interface ListenerStatus {
    url: string; // "https://127.0.0.1:3443/"
    /** The certificates new connections get; empty without TLS. */
    certificates: { subject: string; serverName?: string; notAfter: number }[];
    /** Requests in flight and open WebSockets, as Bun counts them. */
    requests: number;
    webSockets: number;
  }
  ```

- During a hot swap, the entries are the installed instance's: the old instance's until the switch, then the new instance's. The requests and WebSockets that the old instance still drains after the switch show in no entry, as its calls don't show in `inFlight`.
- The rack logs, with the device's name:
  - `listening`, with `data.url`, when a listener binds, so a device can listen on port 0 and still be found. A hot swap logs `listener handed over` instead.
  - `listener handed over`, with `data.url` and the old and new firmware, in a hot swap.
  - `listener closed`, with `data.url`, when a listener stops and no other instance takes it over at once: at an unplug and at `stop()`, in a cold swap, a restart, or a group replacement, and when its instance ends.
  - `certificates replaced` and `certificates rejected`, with `data.url`, the subjects, and the expiry dates or the error.
  - The error of a conflict, as part of the failed start, swap, or reset.
- Calls that panels make are calls between devices. They count among the panels' needs and the targets' ports, like every call between devices. So `metrics().outside` from [Counters for calls from outside the rack](261117_185225-outside-call-metrics.md#decision) counts only the calls through `rack.call()`.

### Tests

The tests run on Linux, macOS, and Windows, and exercise each failure path:

- A hot swap of a device with a listener, under keep-alive clients and under a loop of requests on new connections:
  - No request fails, except on Linux, where a test that opens a new connection per request allows the rare reset that the README states.
  - Requests in flight on the old instance finish, and its WebSockets close with 1012.
  - Requests that reach the new instance before its install are answered after it.
- A hot swap with a state handover: requests during the handover see the restored state, also when the handover takes longer than `idleTimeout`, and a response that streams on the old instance doesn't hold the handover.
- A hot swap that fails at each step: the old instance serves, listening again where it had stopped, and the requests the new instance held get 503.
- A cold swap and a restart refuse connections between the stop and the start, and the new instance listens on the same port.
- An unplug and `stop()` close the WebSockets with 1001.
- A crash and a watchdog bite end the connections, and the reset listens on the same port. Port 0 keeps its port through swaps, resets, restarts, and fallbacks.
- A thread stuck in native code keeps its port, and `status()` lists its listeners.
- Conflicts: two devices on one port, a port that another process holds with and without `reusePort`, a second rack on the same port, and `0.0.0.0` against `127.0.0.1` in one rack. Each fails with `RACK_HOOK_FAILED` and names the holder. A device that catches the rejection still fails its `powerOn`.
- A loopback listener answers 403 to a request, and to a WebSocket upgrade, for another host, and serves its `hostname`, `localhost`, and the names in `allowedHosts`. A listener on `0.0.0.0` serves any host.
- The defaults: a listener binds to `127.0.0.1`; a body over 1 MiB gets 413; a WebSocket message over 1 MiB closes with 1009; a client that doesn't read is closed with 1013 once 1 MiB is unsent; an idle keep-alive connection closes after `idleTimeout`, within Bun's steps of 4 s.
- `setTls()`, with one pair and with an SNI list, gives new connections the new certificate and keeps old ones open. A bad pair is rejected, and the old certificates stay. A second `setTls()` while WebSockets from before the first one are open closes them with 1012. `publish()` reaches the WebSockets on both servers of a listener.
- `status()` and the log report listeners, certificates, requests, and WebSockets.

### Scope

- `ctx.serve` covers HTTP and WebSocket over TCP.
- A device may still open other sockets itself, with `Bun.listen`, `Bun.connect`, and `Bun.udpSocket`, or with `Bun.serve`. They close with its instance, and the rack neither sees them nor hands them over. A later decision may add that.
- This decision, [The standard HTTP panel](261118_071513-http-panel-device.md), and [Byte streams in calls between devices](261118_071155-backplane-streams.md) cover the HTTP panel, its WebSockets, and streaming bodies of the P3 items the user listed on 2026-11-18. Each of the other items builds on them and gets a decision of its own afterward, in the order agreed with the user: a bench that tests one device on its own, running a rack inside another program such as a Tauri app, and the TCP/UDP tool in `examples/net-tool`. The package stays unpublished until the basic features are done, as the user decided.

## Alternatives

- **Keep the panel on the main thread and add options**: the panel could keep WebSockets open through route edits with `server.reload()`, as the hot swap decision planned. But untrusted network I/O and TLS would run on the thread that supervises the rack, without a watchdog. Panels couldn't be added or replaced like devices, devices couldn't run their own servers, and a fault in the panel would affect the whole rack.
- **Let devices call `Bun.serve` with no rack support**: nothing new to build. But a hot swap of such a device would fail on its busy port, or refuse connections for a moment if the old instance closed its server first: 8 of 1,188 requests failed locally, and requests failed on every system. Clashes and other processes on the port would go unnoticed, and `status()` would show nothing.
- **Break before make everywhere**: stop the old listener, then bind the new one without `reusePort`. No other process could ever join the port. But it loses requests on every system, while sharing the port lost none.
- **Pass sockets from the old Worker to the new one**: the connections themselves would survive a swap. But Bun has no way to pass a socket between Workers.
- **Run panels as `inline` devices on the main thread**: no Worker hop. But the `inline` form isn't implemented, and it would bring network I/O back to the main thread.
- **Bind the new listener as soon as `powerOn` declares it, and hold its requests until the switch**: simpler steps. But on Linux about half the new connections, and on macOS all of them, would wait through the new instance's `selfTest` and the old instance's `deactivate`.

## Impact

- The costs, stated plainly:
  - Replacing a device behind a panel keeps every connection, as today.
  - Replacing a panel device itself, for example by editing its routes, kept HTTP serving without failed requests on every supported system in the probes, except the rare reset on Linux. A request sent on a keep-alive connection as it closes can still fail where its client doesn't retry it. Its WebSockets close with 1012, at the latest at the end of its drain, and clients must reconnect: a browser's `WebSocket` doesn't reconnect by itself. Today's panel has no WebSockets. The main-thread handler that the hot swap decision planned would have kept them open through route edits.
  - A cold swap, a restart, or a reset of a device with listeners refuses connections until its new instance is active.
  - A thread stuck in native code keeps its port until it ends, and connections to it get no answer.
  - During a hot swap, the device runs two servers for a moment. `setTls()` does the same inside an instance, until the connections opened before it close, or the next `setTls()` closes them. Each server allocates about 500 KB.
  - The check for other processes refuses a second process on a port that the rack holds. That rules out the rack upgrade that [Live manifest edits and rack upgrades](261112_035943-hot-swap.md#live-manifest-edits-and-rack-upgrades) anticipates, a new rack process that binds the same port with `reusePort`, until a decision for it adds an explicit handover.
- How the accepted decisions this one affects are handled once it is accepted:
  - [Rack runtime architecture](261112_035942-rack-architecture.md#basic-units): its Panel entry says that the rack owns the ports. It stays as it is, with this note, and this decision comes first where they differ, as with [direct links](261116_024226-backplane-links.md#impact) and [automatic assembly](261116_233919-automatic-assembly.md#impact).
  - [Every device supports hot swap and hot reload](261112_035943-hot-swap.md): its sections [The main thread never loads device code](261112_035943-hot-swap.md#the-main-thread-never-loads-device-code), which lists the panel among the main thread's parts, and [The rack owns external connections](261112_035943-hot-swap.md#the-rack-owns-external-connections) give way to this decision. Its plan in [Live manifest edits and rack upgrades](261112_035943-hot-swap.md#live-manifest-edits-and-rack-upgrades) to upgrade a rack through a second process on the same port waits for a decision of its own, as the costs above say. The decision is broad, so it stays as it is, with this note, and this decision comes first where they differ.
  - [Device and rack API](261112_043034-device-api.md#device-context): `DeviceContext` gains `serve`. It stays, with this note, as [Transfer and shared buffers for binary data](261116_213839-transfer-and-shared-buffers.md#impact) did when it added `transfer`.
  - [P0 standard connectors, rack handle shapes, and test fixtures](261115_222025-p0-api-details.md#rack-handle): its `panel http listening` entry gives way to `listening`, with `data.url` and the device's name. It stays, with this note; [The standard HTTP panel](261118_071513-http-panel-device.md) lists its other changes.
  - [Hot swaps, cold swaps, and restarts](261116_233956-cold-swaps-and-restarts.md#what-a-hot-swap-hands-over): its table says that HTTP connections stay with the panel. They still do when the device behind a panel swaps, and a device's own listeners are handed over as this decision describes. It stays, with this note.
  - [Counters for calls from outside the rack](261117_185225-outside-call-metrics.md#decision): `outside` counts only `rack.call()` once panels are devices. Its rules for those calls stand, so it stays, with this note.
  - [Ending instances and stuck threads](261117_185131-ending-instances.md#observation): a stuck thread's entry gains its listeners. It stays, with this note.
  - [Management endpoint and the rack ctl command](261117_005821-management-endpoint.md): it stays on the main thread, unchanged. Its `status` operation returns the new `listeners`.
  - [Windows as a supported platform](261118_015204-windows.md#differences-the-readme-states): Windows shares ports like the other systems, so this decision adds no Windows difference. It stays unchanged.
  - [Design goals and principles](261117_062916-design-principles.md): unchanged. This decision serves its goals as `## Background` lists them.
- `AGENTS.md` changes in the same change as the implementation:
  - Hard constraint 5 becomes: "Panels are devices. The rack's main thread holds no external connections except the management endpoint; devices open listeners with `ctx.serve`, which the rack hands over across swaps." `AGENTS.md` requires an accepted decision to change a hard constraint; this decision is that one.
  - The architecture overview drops the panel from the main thread, and its basic composition says that panels are devices that hold the external ports.
  - The glossary's Panel entry becomes "A device that owns external connections, such as the standard HTTP panel, and passes the work to other devices through the backplane", and a new entry defines Listener, `listener`.
- The README gains a section on listeners, the `listeners` field of `status()`, the `Host` check of loopback listeners and `allowedHosts`, that `ws.publish()` reaches one server while `listener.publish()` reaches all, the Linux and macOS notes above, the limit for requests on keep-alive connections that close during a handover, and new rows in the Concepts table. Its hot swap table and its Panel entry change.
- Follow-up work once this decision is accepted, together with [The standard HTTP panel](261118_071513-http-panel-device.md):
  - `ctx.serve`, binding, holding requests, handovers, and `setTls` in `src/worker.ts` and `src/device.ts`.
  - The listener table, conflicts, port 0, the steps of each swap, `status()`, and the log in `src/rack.ts`, with new control messages in `src/protocol.ts` and `src/instance.ts`.
  - The tests above, in a new `test/listeners.test.ts`.
  - The removal of the main-thread panel, which the standard HTTP panel replaces.

## Implementation

- **Modules.**
  - `src/listeners.ts` is the Worker host's side: `ctx.serve`, the checks of options and certificates, binding and stopping, the requests that wait for the install, `setTls()`, `publish()`, `reload()`, the `Host` check, and the WebSocket guards.
  - `src/rack.ts` keeps the table of addresses and the ports each device keeps. It answers the reservations, hands each `powerOn` the device's earlier listeners, switches listeners in a hot swap, and stops them for cold replacements and power-downs. It also writes the log entries and the `listeners` of `status()`.
  - `src/instance.ts` answers the Worker host's asks and reads the listeners' counters, and `src/protocol.ts` holds the messages.
- **Messages.**
  - The Worker host asks the main thread to reserve an address with an `ask` notice, which the main thread answers with an `answer` message.
  - The `powerOn` request carries the device's earlier listeners, with their ports and whether an instance of the device listens on them now.
  - `listen` and `unlisten` put the listeners into service and out of it. Their replies list the URLs, which the log entries need.
  - A `listeners` notice reports the URLs and certificates. Two counters per listener in the instance's shared memory hold its requests and WebSockets.
- **Details the decision left open.**
  - A fixed or inherited port is reserved in the table before the bind that checks for other processes, so that a device of the rack that holds it is named as the holder. Port 0 is checked first, since the check picks the port, then reserved.
  - The Worker host checks certificates by binding a server with them on `127.0.0.1`, port 0, for a moment.
  - A request whose handler is running JavaScript when its Worker is terminated, as in a watchdog bite, gets Bun's placeholder answer, a 200 that says "Welcome to Bun!", instead of failing; one whose handler awaits fails with `ECONNRESET`. So the Worker host runs every handler after a `setImmediate`, outside Bun's callback, and the request fails. A microtask isn't enough. Measured on 2026-11-18 on the local machine with Bun 1.4.4: 10 000 requests from 50 clients took 126 ms instead of 101 ms.
  - The counters copy Bun's `pendingRequests` and `pendingWebSockets` at each request, at each WebSocket that opens or closes, and every 100 ms, which also lets the drain of a retirement see a streamed response end.
  - `maxBuffered` shadows `send`, `sendText`, and `sendBinary` on each WebSocket. `backpressureLimit` is `maxBuffered` plus `maxPayloadLength`.
  - A `Response` in `routes` is served by a handler that clones it, so that the `Host` check and the wait for the install apply to it too.
  - Without an `error` handler, a handler that throws gets 500, and the log has `a request handler failed`.
- **The main-thread panel** went with the change that added [the standard HTTP panel](261118_071513-http-panel-device.md): `src/panel.ts` and `src/http.ts` are gone, and so is the panel's code in `src/rack.ts`, `src/manifest.ts`, and `src/index.ts`. `AGENTS.md` and the README's Panel entry changed in the same change, as [Impact](#impact) says.
- **Tests:** `test/listeners.test.ts`, with the fixtures `test/fixtures/listener-device.ts`, `devices/listener.ts`, `devices/listener-state.ts`, `devices/listener-cold.ts`, and the test certificates in `test/fixtures/certs`.
- **Resets on Windows.** The first CI run of these tests, run 44435790874 on 2026-11-19, saw one request on a new connection fail during a hot swap on Windows, where [Evidence](#evidence) found that every new connection goes to the old listener until it stops. So the README states the limit of a handover for Windows as well as Linux, and the test allows up to 2 such failures on both, while no request may fail with a status.

## Confirmation

- The user accepted this decision on 2026-11-18. The user asked that devices can have their own HTTP panels, that network components such as the HTTP panel be devices, so that connection management is separate, and that listeners use loopback by default.
- The user left the research and the implementation to the Agent. The Agent measured port handovers on Linux, macOS, and Windows, and settled the details, such as the `Host` check of loopback listeners, before the user accepted.
