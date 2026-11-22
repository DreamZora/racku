/**
 * `net/v1`: the TCP clients, TCP servers, and UDP sockets that the net device holds.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#netv1
 */
import { connector, event, rpc } from "racku";
import * as v from "valibot";

const Port = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65_535));

/** A host and a port, such as a socket's local or remote address. */
export const Address = v.object({ host: v.string(), port: Port });
export type Address = v.InferOutput<typeof Address>;

/** What a socket is: one of the three kinds `open` makes, or a connection a server accepted. */
export const SocketKind = v.picklist(["tcp-client", "tcp-server", "tcp-connection", "udp"]);

/** One open socket, as `list` reports it. */
export const SocketInfo = v.object({
  id: v.number(),
  kind: SocketKind,
  /** For a connection a server accepted, the server's id. */
  server: v.optional(v.number()),
  local: Address,
  remote: v.optional(Address),
  /** Bytes written to the socket, and bytes read from it. */
  sent: v.number(),
  received: v.number(),
  /** The `data` events emitted for the socket. */
  events: v.number(),
});
export type SocketInfo = v.InferOutput<typeof SocketInfo>;

export const Net = connector("net/v1", {
  /** Opens a TCP client, a TCP server, or a UDP socket on `host` and `port`; 0 picks a port. */
  open: rpc(
    v.object({
      kind: v.picklist(["tcp-client", "tcp-server", "udp"]),
      host: v.pipe(v.string(), v.minLength(1)),
      port: Port,
    }),
    v.object({ id: v.number(), local: Address, remote: v.optional(Address) }),
  ),
  /** Sends bytes on a TCP client or connection, or a datagram on a UDP socket to `to`. */
  send: rpc(
    v.object({ id: v.number(), data: v.instance(Uint8Array), to: v.optional(Address) }),
    v.object({ sent: v.number() }),
  ),
  /** Closes a socket; closing a server closes its connections too. */
  close: rpc(v.object({ id: v.number() }), v.undefined()),
  list: rpc(v.undefined(), v.array(SocketInfo)),
  /** A TCP client that connected, or a connection that a server accepted. */
  opened: event(
    v.object({ id: v.number(), server: v.optional(v.number()), local: Address, remote: Address }),
  ),
  /** One read of a TCP socket, or one UDP datagram, with its sender. */
  data: event(
    v.object({ id: v.number(), data: v.instance(Uint8Array), from: v.optional(Address) }),
  ),
  closed: event(v.object({ id: v.number(), error: v.optional(v.string()) })),
});
