/**
 * The net tool's sockets: TCP clients, TCP servers and the connections they accept, and UDP
 * sockets. They belong to the instance, so they close with it, a hot swap included.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#netv1
 */
import { device, RackError } from "racku";
import * as v from "valibot";
import { type Address, Net, type SocketInfo } from "../connectors.ts";

/** The largest TCP send, in bytes. */
const TCP_SEND_LIMIT = 64 * 1024;
/** The largest UDP datagram over IPv4, in bytes. */
const UDP_SEND_LIMIT = 65_507;
/** The most bytes waiting to go out on one TCP socket; a peer that reads slower meets it. */
const TCP_PENDING_LIMIT = 1024 * 1024;

interface SocketData {
  id: number;
}

interface Counted {
  sent: number;
  received: number;
  events: number;
}

interface TcpEntry extends Counted {
  kind: "tcp-client" | "tcp-connection";
  socket: Bun.Socket<SocketData>;
  server?: number;
  local: Address;
  remote: Address;
  /** Bytes the socket hasn't taken yet, oldest first. */
  pending: Uint8Array[];
  pendingBytes: number;
}

interface ServerEntry extends Counted {
  kind: "tcp-server";
  listener: Bun.TCPSocketListener<SocketData>;
  local: Address;
}

interface UdpEntry extends Counted {
  kind: "udp";
  socket: Bun.udp.Socket<"uint8array">;
  local: Address;
}

type Entry = TcpEntry | ServerEntry | UdpEntry;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default device({
  model: "net",
  provides: { net: Net },
  config: v.optional(
    v.object({ maxSockets: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 64) }),
    {},
  ),

  powerOn(ctx) {
    const sockets = new Map<number, Entry>();
    let next = 0;
    let opening = 0;
    const emit = ctx.emit.net;
    const report = (emitted: Promise<void>) =>
      emitted.catch((error: unknown) =>
        ctx.log.warn("event not emitted", { error: messageOf(error) }),
      );

    const reserve = () => {
      if (sockets.size + opening >= ctx.config.maxSockets) {
        throw new RackError("RACK_OVERLOADED", `at most ${ctx.config.maxSockets} sockets are open`);
      }
    };
    const find = (id: number): Entry => {
      const entry = sockets.get(id);
      if (entry === undefined) throw new RackError("NET_UNKNOWN_SOCKET", `no socket ${id} is open`);
      return entry;
    };
    const closed = (id: number, error?: Error) => {
      if (!sockets.delete(id)) return;
      report(emit.closed(error === undefined ? { id } : { id, error: error.message }));
    };
    const flush = (entry: TcpEntry) => {
      while (entry.pending.length > 0) {
        const chunk = entry.pending[0] as Uint8Array;
        const written = Math.max(0, entry.socket.write(chunk));
        entry.sent += written;
        entry.pendingBytes -= written;
        if (written < chunk.byteLength) {
          entry.pending[0] = chunk.subarray(written);
          return;
        }
        entry.pending.shift();
      }
    };
    const tcp: Bun.SocketHandler<SocketData> = {
      data(socket, chunk) {
        const entry = sockets.get(socket.data.id);
        if (entry === undefined) return;
        entry.received += chunk.byteLength;
        entry.events++;
        // A copy, since the event goes out after an await, and Bun may reuse the buffer.
        report(emit.data({ id: socket.data.id, data: new Uint8Array(chunk) }));
      },
      drain(socket) {
        const entry = sockets.get(socket.data.id);
        if (entry?.kind === "tcp-client" || entry?.kind === "tcp-connection") flush(entry);
      },
      close(socket, error) {
        closed(socket.data.id, error);
      },
      error(socket, error) {
        ctx.log.warn("socket failed", { id: socket.data.id, error: error.message });
      },
    };
    const addressesOf = (socket: Bun.Socket<SocketData>) => ({
      local: { host: socket.localAddress, port: socket.localPort },
      remote: { host: socket.remoteAddress, port: socket.remotePort },
    });

    const accept = (server: number, socket: Bun.Socket<SocketData>) => {
      if (sockets.size + opening >= ctx.config.maxSockets) {
        socket.data = { id: 0 };
        socket.end();
        ctx.log.warn("refused a connection beyond maxSockets", { server });
        return;
      }
      const id = ++next;
      socket.data = { id };
      const { local, remote } = addressesOf(socket);
      const entry: TcpEntry = {
        kind: "tcp-connection",
        socket,
        server,
        local,
        remote,
        pending: [],
        pendingBytes: 0,
        sent: 0,
        received: 0,
        events: 0,
      };
      sockets.set(id, entry);
      report(emit.opened({ id, server, local, remote }));
    };

    // The sockets end with the instance, which is how a swap or a stop closes them.
    ctx.signal.addEventListener("abort", () => {
      for (const entry of sockets.values()) {
        if (entry.kind === "tcp-server") entry.listener.stop(true);
        else if (entry.kind === "udp") entry.socket.close();
        else entry.socket.end();
      }
      sockets.clear();
    });

    return {
      net: {
        async open({ kind, host, port }) {
          reserve();
          opening++;
          const id = ++next;
          try {
            if (kind === "tcp-client") {
              const socket = await Bun.connect<SocketData>({
                hostname: host,
                port,
                data: { id },
                socket: tcp,
              }).catch((error: unknown) => {
                throw new RackError(
                  "NET_CONNECT_FAILED",
                  `cannot connect to ${host}:${port}: ${messageOf(error)}`,
                );
              });
              const { local, remote } = addressesOf(socket);
              sockets.set(id, {
                kind,
                socket,
                local,
                remote,
                pending: [],
                pendingBytes: 0,
                sent: 0,
                received: 0,
                events: 0,
              });
              report(emit.opened({ id, local, remote }));
              return { id, local, remote };
            }
            if (kind === "tcp-server") {
              let listener: Bun.TCPSocketListener<SocketData>;
              try {
                listener = Bun.listen<SocketData>({
                  hostname: host,
                  port,
                  data: { id: 0 },
                  socket: { ...tcp, open: (socket) => accept(id, socket) },
                });
              } catch (error) {
                throw new RackError(
                  "NET_LISTEN_FAILED",
                  `cannot listen on ${host}:${port}: ${messageOf(error)}`,
                );
              }
              const local = { host: listener.hostname, port: listener.port };
              sockets.set(id, { kind, listener, local, sent: 0, received: 0, events: 0 });
              return { id, local };
            }
            const entry: UdpEntry = {
              kind,
              socket: await Bun.udpSocket({
                hostname: host,
                port,
                binaryType: "uint8array",
                socket: {
                  data(_socket, chunk, fromPort, fromHost) {
                    entry.received += chunk.byteLength;
                    entry.events++;
                    const from = { host: fromHost, port: fromPort };
                    report(emit.data({ id, data: chunk.slice(), from }));
                  },
                  error(_socket, error) {
                    ctx.log.warn("socket failed", { id, error: error.message });
                  },
                },
              }).catch((error: unknown) => {
                throw new RackError(
                  "NET_LISTEN_FAILED",
                  `cannot bind ${host}:${port}: ${messageOf(error)}`,
                );
              }),
              local: { host, port },
              sent: 0,
              received: 0,
              events: 0,
            };
            entry.local = { host: entry.socket.address.address, port: entry.socket.port };
            sockets.set(id, entry);
            return { id, local: entry.local };
          } finally {
            opening--;
          }
        },

        send({ id, data, to }) {
          const entry = find(id);
          if (entry.kind === "tcp-server") {
            throw new RackError(
              "RACK_INVALID_INPUT",
              `socket ${id} is a server; send to one of its connections`,
            );
          }
          if (entry.kind === "udp") {
            if (to === undefined) {
              throw new RackError("RACK_INVALID_INPUT", "a UDP send needs the address to send to");
            }
            if (data.byteLength > UDP_SEND_LIMIT) {
              throw new RackError(
                "RACK_INVALID_INPUT",
                `a UDP datagram carries at most ${UDP_SEND_LIMIT} bytes`,
              );
            }
            if (!entry.socket.send(data, to.port, to.host)) {
              throw new RackError("RACK_OVERLOADED", `socket ${id} can't send more for now`);
            }
            entry.sent += data.byteLength;
            return { sent: data.byteLength };
          }
          if (data.byteLength > TCP_SEND_LIMIT) {
            throw new RackError(
              "RACK_INVALID_INPUT",
              `a TCP send carries at most ${TCP_SEND_LIMIT} bytes`,
            );
          }
          if (entry.pendingBytes + data.byteLength > TCP_PENDING_LIMIT) {
            throw new RackError(
              "RACK_OVERLOADED",
              `socket ${id} has ${entry.pendingBytes} bytes waiting for its peer`,
            );
          }
          entry.pending.push(data);
          entry.pendingBytes += data.byteLength;
          flush(entry);
          return { sent: data.byteLength };
        },

        close({ id }) {
          const entry = find(id);
          if (entry.kind === "tcp-server") {
            entry.listener.stop(true);
            closed(id);
          } else if (entry.kind === "udp") {
            entry.socket.close();
            closed(id);
          } else entry.socket.end();
        },

        list() {
          const listed: SocketInfo[] = [];
          for (const [id, entry] of sockets) {
            const { kind, local, sent, received, events } = entry;
            const info: SocketInfo = { id, kind, local, sent, received, events };
            if (entry.kind === "tcp-client" || entry.kind === "tcp-connection") {
              info.remote = entry.remote;
              if (entry.server !== undefined) info.server = entry.server;
            }
            listed.push(info);
          }
          return listed;
        },
      },
    };
  },
});
