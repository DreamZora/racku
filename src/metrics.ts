/**
 * Call and event counters that `rack.metrics()` returns. Each instance's Worker host keeps them
 * for its device from boot until the instance exits.
 *
 * @decision .agents/decisions/261116_035534-call-metrics.md#reading
 */

/** Counters of one RPC member of a provided port: the calls the device served. */
export interface ServedRpcMetrics {
  kind: "rpc";
  /** Calls received, including calls from `rack.call` and the panel. */
  calls: number;
  /** Calls that succeeded. */
  ok: number;
  /** Failed calls by error code. */
  errors: Record<string, number>;
  /** Calls received and not answered yet. */
  active: number;
  /** Total time from receipt to reply of the answered calls, in milliseconds. */
  timeMs: number;
}

/** Counters of one event member of a provided port. */
export interface EmittedEventMetrics {
  kind: "event";
  /** Events whose payload passed validation. */
  emitted: number;
  /** Deliveries that did not happen: the instance was not installed, or a held consumer's queue was full. */
  dropped: number;
}

/** Counters of one RPC member of a need: the calls the device made. */
export interface CalledRpcMetrics {
  kind: "rpc";
  /** Calls started. */
  calls: number;
  /** Calls that succeeded. */
  ok: number;
  /** Failed calls by error code, `RACK_TIMEOUT` and `RACK_CANCELLED` included. */
  errors: Record<string, number>;
  /** Calls started and not finished yet, queued ones included. */
  pending: number;
  /** Calls waiting because the provider's slot is held. */
  queued: number;
  /** Total time from call to result of the finished calls, in milliseconds. */
  timeMs: number;
}

/** Counters of one event member of a need. */
export interface ReceivedEventMetrics {
  kind: "event";
  /** Events delivered to the device, however many handlers it has. */
  received: number;
}

/** Counters of a provided port, keyed by member name. */
export type PortMetrics = Record<string, ServedRpcMetrics | EmittedEventMetrics>;

/** Counters of a need, keyed by member name. */
export type NeedMetrics = Record<string, CalledRpcMetrics | ReceivedEventMetrics>;

/** Counters of one device's installed instance. */
export interface DeviceMetrics {
  /** Device name. */
  device: string;
  /** Firmware hash of the instance that counted. */
  firmware: string;
  /** Millisecond timestamp of the instance's boot; counters start there. */
  since: number;
  /** Counters of each provided port, keyed by port name. */
  provides: Record<string, PortMetrics>;
  /** Counters of each need, keyed by need name. */
  needs: Record<string, NeedMetrics>;
}

/** What `rack.metrics()` resolves with. */
export interface RackMetrics {
  /** One entry per device whose installed instance answered, ordered by slot from the bottom up. */
  devices: DeviceMetrics[];
}

/** What an instance reports; the rack adds the device name and firmware hash. */
export type InstanceMetrics = Omit<DeviceMetrics, "device" | "firmware">;
