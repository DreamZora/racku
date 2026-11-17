/**
 * The HTTP panel: the rack owns the listening socket, and each route forwards requests to an
 * `http/v1` port through the backplane, resolving the installed instance on every request.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#panel-http
 * @decision .agents/decisions/261112_035943-hot-swap.md#the-rack-owns-external-connections
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
 */
import type { CallOptions } from "./device.ts";
import { RackError } from "./errors.ts";
import type { HttpPanelSpec } from "./manifest.ts";

/** Sends one `http/v1` call; the rack's external call path. */
export type HttpCall = (address: string, input: unknown, options: CallOptions) => Promise<unknown>;

/** A running panel. */
export interface Panel {
  readonly url: URL;
  /**
   * Replaces the routes without closing the server, for an edited manifest; open connections
   * and requests in progress continue.
   *
   * @throws RackError `RACK_MANIFEST` when a route pattern is invalid; the old routes stay.
   */
  setRoutes(routes: Readonly<Record<string, string>>): void;
  /** Stops accepting connections and waits for open requests. */
  stop(): Promise<void>;
}

interface HttpOutput {
  status: number;
  headers: [string, string][];
  body: Uint8Array | null;
}

const STATUS_BY_CODE: Record<string, number> = { RACK_LINK_DOWN: 503, RACK_TIMEOUT: 504 };

/**
 * Opens the HTTP panel.
 *
 * @param spec Port and routes from the manifest.
 * @param call Forwards a request to a `<device>.<port>` address.
 * @returns The running panel.
 * @throws RackError `RACK_MANIFEST` when the server cannot listen or a route pattern is invalid.
 */
export function openHttpPanel(spec: HttpPanelSpec, call: HttpCall): Panel {
  const handlers = (table: Readonly<Record<string, string>>) => {
    const routes: Record<string, (request: Bun.BunRequest) => Promise<Response>> = {};
    for (const [pattern, address] of Object.entries(table)) {
      routes[pattern] = (request) => forward(request, address, call);
    }
    return routes;
  };
  const notFound = () => new Response("Not Found", { status: 404 });
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({ port: spec.port, routes: handlers(spec.routes), fetch: notFound });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RackError(
      "RACK_MANIFEST",
      `panel http cannot listen on port ${spec.port}: ${message}`,
    );
  }
  return {
    url: server.url,
    setRoutes(table) {
      try {
        server.reload({ routes: handlers(table), fetch: notFound });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RackError("RACK_MANIFEST", `panel http cannot take the new routes: ${message}`);
      }
    },
    stop: () => server.stop(),
  };
}

async function forward(
  request: Bun.BunRequest,
  address: string,
  call: HttpCall,
): Promise<Response> {
  const method = request.method;
  const body =
    method === "GET" || method === "HEAD" || request.body === null
      ? null
      : new Uint8Array(await request.arrayBuffer());
  const input = {
    method,
    url: request.url,
    headers: [...request.headers],
    params: { ...request.params },
    body,
  };
  let output: HttpOutput;
  try {
    output = (await call(address, input, { signal: request.signal })) as HttpOutput;
  } catch (error) {
    const code = error instanceof RackError ? error.code : "RACK_DEVICE_FAULT";
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ code, message }, { status: STATUS_BY_CODE[code] ?? 502 });
  }
  try {
    return new Response(output.body, { status: output.status, headers: output.headers });
  } catch (error) {
    // The device returned headers that `Response` rejects, such as an invalid header name.
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ code: "RACK_INVALID_OUTPUT", message }, { status: 502 });
  }
}
