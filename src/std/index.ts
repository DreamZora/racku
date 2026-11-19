/**
 * Entry point of `rack42u/std`: the standard connectors and the factories that mount the
 * standard devices.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-devices
 * @decision .agents/decisions/261118_071513-http-panel-device.md#the-device
 */
import { type SlotSpec, slot } from "../manifest.ts";

export { Kv, Sql } from "./connectors.ts";
export {
  type FetchHandler,
  Http,
  type HttpHandler,
  type HttpHandlers,
  type HttpServer,
  type HttpSocket,
  type HttpSocketState,
  httpHandler,
} from "./http.ts";

/** Options shared by the standard device factories. */
export interface StdDeviceOptions {
  /** Device name; defaults to the model name. */
  name?: string;
}

/** Configuration of the `sqlite` device. */
export interface SqliteConfig {
  /** Database file relative to the rack base directory, or `":memory:"`. */
  path: string;
}

// The factories return paths only: the main thread never loads device code.
// @decision .agents/decisions/261112_035943-hot-swap.md#the-main-thread-never-loads-device-code

/**
 * Mounts `memkv`, an in-memory `kv/v1` store whose entries survive swaps and hot reloads but
 * not crash resets or restarts.
 *
 * @param options Device name.
 * @returns The mount description.
 */
export function memkv(options: StdDeviceOptions = {}): SlotSpec {
  return slot(new URL("./memkv.ts", import.meta.url), { name: options.name });
}

/**
 * Mounts `sqlite`, a `sql/v1` database on `bun:sqlite`.
 *
 * @param config The database path.
 * @param options Device name.
 * @returns The mount description.
 */
export function sqlite(config: SqliteConfig, options: StdDeviceOptions = {}): SlotSpec {
  return slot(new URL("./sqlite.ts", import.meta.url), { name: options.name, config });
}

/** A certificate and its key for the HTTP panel: PEM files, relative to the base directory. */
export interface HttpPanelPair {
  cert: string;
  key: string;
  /** The server name the pair serves, in a list of pairs for SNI. */
  serverName?: string;
}

/**
 * Configuration of the `http-panel` device.
 *
 * @decision .agents/decisions/261118_071513-http-panel-device.md#configuration
 * @decision .agents/decisions/261118_165318-stream-threshold.md#the-threshold
 */
export interface HttpPanelConfig {
  /** The address to listen on; default `127.0.0.1`. `0.0.0.0` listens on every IPv4 interface. */
  hostname?: string;
  /** 0 to 65 535; 0 picks a free port, which the panel keeps while the rack runs. */
  port: number;
  /**
   * Bun route patterns, such as `/orders/:id` and `/api/*`, mapped to `<device>.<port>`
   * addresses of `http/v2` ports.
   */
  routes: Record<string, string>;
  /** The largest request body, in bytes; default 1 MiB. A larger one gets 413. */
  maxBodySize?: number;
  /**
   * The largest request body, in bytes, that goes to the device as bytes; default 256 KiB. A
   * body of a declared length up to it must arrive within `idleTimeout`; a larger one, and a
   * chunked one, stream.
   */
  streamThreshold?: number;
  /**
   * Seconds, 1 to 255; default 10. An idle connection closes, and a body that moves nothing for
   * so long fails.
   */
  idleTimeout?: number;
  /**
   * A certificate pair, or a list of pairs with `serverName` for SNI; without it, the panel
   * speaks plain HTTP.
   */
  tls?: HttpPanelPair | HttpPanelPair[];
  /** How often the panel checks its certificate files, in seconds, 1 to 3 600; default 60. */
  certificateCheck?: number;
  /** More names that clients may send as `Host` to a panel on a loopback hostname. */
  allowedHosts?: string[];
  webSocket?: {
    /** The largest message a client may send, in bytes; default 1 MiB. */
    maxMessageSize?: number;
    /** The most open WebSockets; default 10 000. Upgrades beyond it get 503. */
    maxConnections?: number;
  };
}

/**
 * Mounts `http-panel`, the standard HTTP panel: it listens for HTTP and WebSocket and passes
 * each request through `http/v2` to the port its route names. Place it above the devices it
 * routes to; in a scanned rack, list it in `roots`.
 *
 * @param config The address, the routes, the limits, and the certificates.
 * @param options Device name, for a rack with several panels.
 * @returns The mount description.
 * @decision .agents/decisions/261118_071513-http-panel-device.md#the-device
 */
export function httpPanel(config: HttpPanelConfig, options: StdDeviceOptions = {}): SlotSpec {
  return slot(new URL("./http-panel.ts", import.meta.url), { name: options.name, config });
}
