# Listeners

## Opening a listener

A device can serve HTTP and WebSocket itself, on a listener that the rack hands over when the device swaps. It opens the listener with `ctx.serve()` in `powerOn`:

```ts
async powerOn(ctx) {
  const web = await ctx.serve({
    port: 8080, // 0 picks a free port, which the device keeps while the rack runs
    fetch: (request, listener) =>
      listener.upgrade(request) ? undefined : new Response("hello"),
    websocket: { message: (ws, data) => ws.send(data) },
  });
  ctx.log.info("serving", { url: web.url.href });
  return {};
},
```

The options are the ones of `Bun.serve` that a device needs: `fetch`, `routes`, `error`, `websocket`, `tls`, `hostname`, `port`, `maxRequestBodySize`, and `idleTimeout`, plus `allowedHosts`. The handlers receive the listener where `Bun.serve` passes its server; its `upgrade()`, `timeout()`, and `requestIP()` work as Bun's do.

| Option | Default | Beyond it |
|---|---|---|
| `hostname` | `127.0.0.1` | |
| `maxRequestBodySize` | 1 MiB | Bun answers 413. |
| `idleTimeout` | 10 s, from 1 to 255 | The connection closes. Bun applies it in steps of 4 s, and it also cuts a request whose whole exchange takes longer: traffic doesn't extend it. `listener.timeout(request, seconds)` extends it for one request. |
| `websocket.maxPayloadLength` | 1 MiB | The WebSocket closes with 1009. |
| `websocket.maxBuffered` | 1 MiB unsent | A WebSocket that has more unsent when the device sends to it closes with 1013. |
| `allowedHosts` | none | On a loopback `hostname`, a request whose `Host` header names any other host than the hostname, `localhost`, or these names gets 403, WebSocket upgrades included. |

## Swaps and faults

- **When it listens:** `serve()` reserves the address, and the listener binds once the instance goes into service. Requests that arrive before the instance is installed wait for it, at most `queueLimit` per listener; beyond that they get 503. `ctx.serve()` works in `powerOn` only, and a `powerOn` in which a `serve()` rejected fails, even when the device caught it. An instance has at most 16 listeners.
- **Hot swaps:** the new instance binds the same address with `reusePort`, and only then does the old one stop listening, so requests keep being answered. Requests in flight on the old instance finish, and its WebSockets close with 1012, "service restart"; clients must reconnect. With a state handover, the requests that arrive during it wait for the new instance and see the restored state, and a response that still streams on the old instance doesn't hold the handover. A swap that fails leaves the old instance listening, and the requests that the new one held get 503.
- **Limits of a handover:** on Linux and Windows, a connection that the system queued for the old listener just as it stops can be reset. A request sent on an idle keep-alive connection as the old listener closes it can fail, unless its client retries it, as HTTP clients commonly do for idempotent methods.
- **Cold swaps and restarts:** nothing listens from the stop of the old instance to the end of the new one's `activate`, and connections are refused meanwhile. The new instance listens on the same port.
- **Unplugs and `stop()`** close the WebSockets with 1001, "going away".
- **Crashes and watchdog bites** end the instance's connections, and its requests in flight fail. The reset listens on the same port.
- **Port 0** keeps its port through swaps, restarts, resets, and fallbacks, until the device is unplugged or the rack stops.
- **Stuck threads:** a thread stuck in native code keeps the listeners it hadn't stopped. The system still accepts connections to them, and nothing answers. `status()` lists them with the stuck thread.

## Conflicts

Two devices on one port fail with `RACK_HOOK_FAILED`, whatever their hostnames, and so does a port that another process holds, a second rack included. `data` names the `listener`, `<hostname>:<port>`, and its `holder`: the device, or `another process`, with the system's code in `cause`. On macOS, the check doesn't see another process that holds the port on another hostname, such as `0.0.0.0` against `127.0.0.1`. IPv6 was not measured.

## Certificates

`tls` takes `{ cert, key }`, such as `Bun.file()`s of PEM files, or a list of them with `serverName`, from which a client gets a certificate by its server name, and an unknown name the first. Certificates that don't load fail `powerOn`. `listener.setTls(tls)` replaces them while the rack runs: new connections get the new ones, and connections opened under the old ones keep working. Certificates that don't load are rejected with `RACK_INVALID_CONFIG`, and the old ones stay. A listener keeps at most two servers, so a further `setTls()` closes the WebSockets opened before the previous one with 1012.

Bun's WebSocket topics belong to one server, so `ws.publish()` misses the WebSockets on a listener's other server after a `setTls()`. `listener.publish(topic, data)` reaches every server.

## Other sockets

A device may still open sockets with `Bun.listen`, `Bun.connect`, `Bun.udpSocket`, or `Bun.serve`. They close with its instance, and the rack neither sees them nor hands them over.

## Bodies in memory

When a handler answers after an `await`, Bun 1.4.4 writes the head of a body of 15 KiB or more in many small writes, several times slower than a smaller one. `wholeResponse(request, body, init?)` from `rack42u` builds the `Response` for a body of bytes or text in the form Bun sends in one write, with its `Content-Length` at every size, its answer to `HEAD` included, and the `Content-Type` Bun would give the body; use it in place of `new Response(body, init)`. A stream goes out chunked either way.

## Files

`fileResponse(file, init?)` from `rack42u` builds the `Response` of a file, a path or a file of `Bun.file()`, which Bun sends from disk as the client reads it, with its `Content-Length` at every size, its answer to `HEAD` included. A relative path resolves against the working directory of the process, as `Bun.file()` resolves it.

- **Its name stays private.** Its `Content-Disposition` is `inline` unless `init` names one, since Bun would send the file's name on disk.
- **Through the HTTP panel.** `httpHandler` sends the panel the file's path, not its bytes, and the panel sends the file itself, as [Requests](http.md#requests) says.
- **A file that can't be read.** A file that is gone or can't be read when the response goes out fails it, as any error of the handler does.

## Observation

`status()` lists each listener of the installed instance under `listeners`: its `url`, its `certificates`, with `subject`, `serverName`, and `notAfter`, its `requests` in flight, and its open `webSockets`. The log reports `listening`, `listener handed over`, and `listener closed`, with `data.url`, and `certificates replaced` and `certificates rejected`.
