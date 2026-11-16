/**
 * Tests for the HTTP panel and the `http/v1` connector.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#panel-http
 * @decision .agents/decisions/261112_035943-hot-swap.md#the-rack-owns-external-connections
 */
import { describe, expect, test } from "bun:test";
import { Http, httpHandler, slot } from "rack42u";
import { describeConnector } from "../src/connector.ts";
import { type Recorder, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const routes = { "/web/*": "web.http", "/items/:id": "web.http" };

async function web(options: { callTimeout?: number } = {}) {
  const { running, rec } = await startRack(
    { slots: { 1: slot("./devices/web.ts") }, panel: { http: { port: 0, routes } } },
    options,
  );
  const base = rec.panelUrl();
  const get = (path: string, init?: RequestInit) => fetch(new URL(path, base), init);
  return { running, rec, get };
}

describe("panel http", () => {
  test("forwards requests to the routed http/v1 port", async () => {
    const { get } = await web();
    const response = await get("/web/greeting");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  test("carries the method, URL, headers, and body", async () => {
    const { get } = await web();
    const response = await get("/web/echo?x=1", {
      method: "POST",
      headers: { "x-test": "yes", "content-type": "text/plain" },
      body: "payload",
    });
    const echoed = (await response.json()) as {
      method: string;
      path: string;
      query: string;
      headers: [string, string][];
      body: string;
    };
    expect(echoed).toMatchObject({
      method: "POST",
      path: "/web/echo",
      query: "?x=1",
      body: "payload",
    });
    expect(echoed.headers).toContainEqual(["x-test", "yes"]);
  });

  test("passes route parameters", async () => {
    const { get } = await web();
    expect(await (await get("/items/42")).json()).toEqual({ id: "42" });
  });

  test("keeps duplicate response headers such as Set-Cookie", async () => {
    const { get } = await web();
    const response = await get("/web/cookies");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  test("answers unmatched paths with 404", async () => {
    const { get } = await web();
    expect((await get("/elsewhere")).status).toBe(404);
  });

  test("maps a device error to 502 with a JSON body", async () => {
    const { get } = await web();
    const response = await get("/web/boom");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "RACK_DEVICE_FAULT", message: "boom" });
  });

  test("maps RACK_TIMEOUT to 504", async () => {
    const { get } = await web({ callTimeout: 100 });
    const response = await get("/web/slow");
    expect(response.status).toBe(504);
    expect(((await response.json()) as { code: string }).code).toBe("RACK_TIMEOUT");
  });

  test("maps RACK_LINK_DOWN to 503", async () => {
    const { running, rec, get } = await web();
    const crashes = (r: Recorder) => r.events.filter((e) => e.type === "fault").length;
    for (let n = 1; n <= 4; n++) {
      await get("/web/crash").catch(() => undefined);
      await waitFor(() => crashes(rec) === n);
      if (n < 4) await waitFor(() => running.status()[0]?.state === "online");
    }
    const response = await get("/web/greeting");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("RACK_LINK_DOWN");
  });

  test("serves through the installed instance after a swap", async () => {
    const { running, get } = await web();
    const before = running.status()[0]?.firmware;
    await running.swap("web");
    expect(await (await get("/web/greeting")).text()).toBe("hello");
    expect(running.status()[0]?.firmware).toBe(before as string);
  });
});

describe("http/v1", () => {
  test("has a single RPC method, handle", () => {
    expect(describeConnector(Http)).toEqual({ id: "http/v1", members: { handle: "rpc" } });
  });

  test("httpHandler turns a fetch function into an http/v1 implementation", async () => {
    const handler = httpHandler(async (request) => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(
        `${request.method} ${new URL(request.url).pathname} ${await request.text()}`,
        {
          status: 201,
          headers,
        },
      );
    });
    const output = await handler.handle(
      {
        method: "PUT",
        url: "http://rack.local/things",
        headers: [["content-type", "text/plain"]],
        params: {},
        body: new TextEncoder().encode("body"),
      },
      { signal: new AbortController().signal, deadline: Date.now() + 1_000 },
    );
    expect(output.status).toBe(201);
    expect(new TextDecoder().decode(output.body as Uint8Array)).toBe("PUT /things body");
    expect(output.headers).toContainEqual(["content-type", "text/plain"]);
    expect(output.headers.filter(([name]) => name === "set-cookie")).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
  });

  test("httpHandler passes call.signal to the request", async () => {
    const controller = new AbortController();
    const handler = httpHandler(
      (request) =>
        new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(new Response("aborted")));
        }),
    );
    const pending = handler.handle(
      { method: "GET", url: "http://rack.local/", headers: [], params: {}, body: null },
      { signal: controller.signal, deadline: Date.now() + 1_000 },
    );
    controller.abort();
    const output = await pending;
    expect(new TextDecoder().decode(output.body as Uint8Array)).toBe("aborted");
  });
});
