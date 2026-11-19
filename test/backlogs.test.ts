/**
 * Tests for bounded backlogs: the calls a need has unfinished, the calls from outside the rack to
 * a device, and the events that wait for a subscriber all stop at `queueLimit`; and providers
 * skip calls whose deadline has passed.
 *
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-calls
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-events
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#stale-calls
 * @decision .agents/decisions/261117_185225-outside-call-metrics.md#decision
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type RackHandle, slot } from "rack42u";
import { httpPanel } from "rack42u/std";
import { errorOf, type TempApp, tempApp, useRacks, waitFor } from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, event, rpc } from "rack42u";
import * as v from "valibot";

export const Slow = connector("demo.slow/v1", {
  wait: rpc(v.number(), v.number()),
  block: rpc(v.number(), v.number()),
  work: rpc(v.undefined(), v.number()),
  runs: rpc(v.undefined(), v.number()),
  burst: rpc(v.number(), v.number()),
  tick: event(v.number()),
});
export const Fan = connector("demo.fan/v1", {
  fanout: rpc(v.object({ n: v.number(), ms: v.number() }), v.array(v.string())),
  block: rpc(v.number(), v.number()),
  received: rpc(v.undefined(), v.number()),
});
`;

/** A provider that answers after a while, blocks its event loop, counts work, and emits. */
function slow(extra = ""): string {
  return `import { device } from "rack42u";
import { Slow } from "../connectors.ts";

let runs = 0;

export default device({
  model: "slow",${extra}
  provides: { slow: Slow },
  powerOn: (ctx) => ({
    slow: {
      wait: (ms) => new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms)),
      block(ms) {
        const until = performance.now() + ms;
        while (performance.now() < until) {}
        return ms;
      },
      work: () => ++runs,
      runs: () => runs,
      async burst(n) {
        for (let i = 0; i < n; i++) {
          await ctx.emit.slow.tick(i);
          await Bun.sleep(1);
        }
        return n;
      },
    },
  }),
});
`;
}

/** A consumer that fans calls out to the provider, and counts the events it takes. */
const FAN = `import { device } from "rack42u";
import { Fan, Slow } from "../connectors.ts";

let received = 0;

export default device({
  model: "fan",
  needs: { slow: Slow },
  provides: { fan: Fan },
  powerOn: (ctx) => ({
    fan: {
      async fanout({ n, ms }) {
        const started = performance.now();
        const calls = Array.from({ length: n }, () =>
          ctx.ports.slow.wait(ms).then(
            () => \`ok after \${Math.round(performance.now() - started)} ms\`,
            (error: { code: string }) =>
              \`\${error.code} after \${Math.round(performance.now() - started)} ms\`,
          ),
        );
        return Promise.all(calls);
      },
      block(ms) {
        const until = performance.now() + ms;
        while (performance.now() < until) {}
        return ms;
      },
      received: () => received,
    },
  }),
  activate(ctx) {
    ctx.on.slow.tick(() => {
      received++;
    });
  },
});
`;

/** An HTTP device that answers after 300 ms, and refuses /busy with its own limit. */
const WEB = `import { device, RackError } from "rack42u";
import { Http, httpHandler } from "rack42u/std";

export default device({
  model: "web",
  provides: { http: Http },
  powerOn: () => ({
    http: httpHandler(async (request) => {
      if (new URL(request.url).pathname === "/busy") {
        throw new RackError("RACK_OVERLOADED", "the device's own limit");
      }
      await Bun.sleep(300);
      return new Response("done");
    }),
  }),
});
`;

async function app(slowDevice = slow()): Promise<TempApp> {
  const created = await tempApp();
  apps.push(created);
  await created.write("connectors.ts", CONNECTORS);
  await created.write("devices/slow.ts", slowDevice);
  await created.write("devices/fan.ts", FAN);
  await created.write("devices/web.ts", WEB);
  return created;
}

const FANNED = { slots: { 1: slot("./devices/slow.ts"), 2: slot("./devices/fan.ts") } };

/** Outcome and timing, as "ok after 312 ms", reduced to the outcome and a coarse time. */
function outcomes(results: string[]): string[] {
  return results.map((result) => {
    const [outcome, ms] = result.split(" after ");
    return `${outcome} ${Number.parseInt(ms ?? "", 10) < 100 ? "at once" : "later"}`;
  });
}

function stateOf(running: RackHandle, name: string): string | undefined {
  return running.status().find((device) => device.name === name)?.state;
}

describe("bounded calls", () => {
  // @doc docs/guides/faults.md#overload
  test("a need at queueLimit refuses more calls at once with RACK_OVERLOADED, and takes calls again as others finish", async () => {
    const created = await app();
    const { running } = await startRack(FANNED, { baseDir: created.dir, queueLimit: 3 });
    const first = await running.call("fan.fan", "fanout", { n: 5, ms: 300 });
    expect(outcomes(first as string[])).toEqual([
      "ok later",
      "ok later",
      "ok later",
      "RACK_OVERLOADED at once",
      "RACK_OVERLOADED at once",
    ]);
    const again = await running.call("fan.fan", "fanout", { n: 3, ms: 10 });
    expect((again as string[]).every((result) => result.startsWith("ok"))).toBe(true);
    const [provider, fan] = (await running.metrics()).devices;
    expect(fan?.needs.slow?.wait).toMatchObject({
      calls: 8,
      ok: 6,
      errors: { RACK_OVERLOADED: 2 },
    });
    // The refused calls never reached the provider.
    expect(provider?.provides.slow?.wait).toMatchObject({ calls: 6, ok: 6 });
  });

  // @doc docs/guides/http.md#requests
  test("calls from outside the rack are bounded per device, and the HTTP panel answers RACK_OVERLOADED with 503", async () => {
    const created = await app();
    const { running, rec } = await startRack(
      {
        slots: {
          1: slot("./devices/slow.ts"),
          3: slot("./devices/web.ts"),
          4: httpPanel({ port: 0, routes: { "/*": "web.http" } }),
        },
      },
      { baseDir: created.dir, queueLimit: 2 },
    );
    const calls = [1, 2, 3].map(() =>
      running.call("slow.slow", "wait", 300).then(
        () => "ok",
        (error: { code: string }) => error.code,
      ),
    );
    expect(await Promise.all(calls)).toEqual(["ok", "ok", "RACK_OVERLOADED"]);
    expect(await running.call("slow.slow", "wait", 1)).toBe(1);
    // The refused call never reached a device, so no device counted it; the rack did.
    const { devices, outside } = await running.metrics();
    expect(devices[0]?.provides.slow?.wait).toMatchObject({ calls: 3, ok: 3, errors: {} });
    expect(outside.ports["slow.slow"]?.wait).toMatchObject({
      calls: 4,
      ok: 3,
      errors: { RACK_OVERLOADED: 1 },
    });
    const url = rec.panelUrl();
    const answers = await Promise.all(
      [1, 2, 3].map(async () => {
        const response = await fetch(new URL("/slow", url));
        const body =
          response.status === 200 ? "" : ((await response.json()) as { code: string }).code;
        return `${response.status} ${body}`.trim();
      }),
    );
    // The panel's need to web.http is bounded like any need. Which request the server takes
    // last is up to the connections, not to the order of fetch.
    expect(answers.sort()).toEqual(["200", "200", "503 RACK_OVERLOADED"]);
    // A device's own limit gets the same answer.
    const busy = await fetch(new URL("/busy", url));
    const { code } = (await busy.json()) as { code: string };
    expect([busy.status, code]).toEqual([503, "RACK_OVERLOADED"]);
    // Both refusals count among the calls of the panel's need, which are calls between devices.
    const after = await running.metrics();
    expect(
      after.devices.find((d) => d.device === "http-panel")?.needs.web_http?.handle,
    ).toMatchObject({
      calls: 4,
      ok: 2,
      errors: { RACK_OVERLOADED: 2 },
    });
    expect(after.outside.ports["web.http"]).toBeUndefined();
  });

  test("calls held while their provider swaps count toward the limit, and the ones beyond it fail with RACK_OVERLOADED", async () => {
    const cold = (ms: number) =>
      `\n  swap: "cold",\n  async selfTest() {\n    await Bun.sleep(${ms});\n  },`;
    const created = await app(slow(cold(600)));
    const { running, rec } = await startRack(FANNED, { baseDir: created.dir, queueLimit: 2 });
    // Other code, so other firmware: the reload swaps the device.
    await created.write("devices/slow.ts", slow(cold(601)));
    const reload = running.reload();
    // The old instance is off: calls to slow are held until the new one is active.
    await waitFor(
      () =>
        rec.events.some(
          (event) => event.type === "power" && event.device === "slow" && event.state === "off",
        ),
      5_000,
    );
    const held = await running.call("fan.fan", "fanout", { n: 4, ms: 10 });
    expect((held as string[]).map((result) => result.split(" after ")[0])).toEqual([
      "ok",
      "ok",
      "RACK_OVERLOADED",
      "RACK_OVERLOADED",
    ]);
    expect((await reload)[0]?.error).toBeUndefined();
    expect(stateOf(running, "slow")).toBe("online");
  });

  // @doc docs/reference/api.md#start
  test("queueLimit is 10 000 by default", async () => {
    const created = await app();
    const { running } = await startRack(FANNED, { baseDir: created.dir });
    const calls = Array.from({ length: 10_001 }, () =>
      running.call("slow.slow", "wait", 500).then(
        () => "ok",
        (error: { code: string }) => error.code,
      ),
    );
    const results = await Promise.all(calls);
    expect(results.filter((result) => result === "ok")).toHaveLength(10_000);
    expect(results.at(-1)).toBe("RACK_OVERLOADED");
  });

  test("the start option queueLimit is a positive integer", async () => {
    const created = await app();
    const error = await errorOf(startRack(FANNED, { baseDir: created.dir, queueLimit: 0 }));
    expect([error.code, error.message]).toEqual([
      "RACK_MANIFEST",
      "start option queueLimit must be a positive integer",
    ]);
  });
});

describe("stale calls", () => {
  // @doc docs/guides/faults.md#overload
  test("a provider answers a call whose deadline passed while it waited with RACK_TIMEOUT, without running it", async () => {
    const created = await app();
    const { running } = await startRack(FANNED, { baseDir: created.dir });
    const blocked = running.call("slow.slow", "block", 500);
    const late = await errorOf(running.call("slow.slow", "work", undefined, { timeout: 100 }));
    expect(late.code).toBe("RACK_TIMEOUT");
    await blocked;
    expect(await running.call("slow.slow", "runs", undefined)).toBe(0);
    const [provider] = (await running.metrics()).devices;
    expect(provider?.provides.slow?.work).toMatchObject({
      calls: 1,
      ok: 0,
      errors: { RACK_TIMEOUT: 1 },
    });
  });
});

describe("bounded events", () => {
  // @doc docs/guides/faults.md#overload
  test("a subscriber queueLimit events behind misses the next ones, counted as dropped, while one that keeps up gets them all", async () => {
    const created = await app();
    const { running } = await startRack(
      {
        slots: {
          1: slot("./devices/slow.ts"),
          2: slot("./devices/fan.ts", { name: "fast" }),
          3: slot("./devices/fan.ts", { name: "lazy" }),
        },
      },
      { baseDir: created.dir, queueLimit: 20 },
    );
    // lazy's event loop is busy for 1.5 s, so it takes no events while the 200 go out.
    const blocked = running.call("lazy.fan", "block", 1_500);
    await Bun.sleep(50);
    expect(await running.call("slow.slow", "burst", 200)).toBe(200);
    await blocked;
    await waitFor(
      async () => (await running.call("lazy.fan", "received", undefined)) === 20,
      2_000,
    );
    expect(await running.call("fast.fan", "received", undefined)).toBe(200);
    const [provider] = (await running.metrics()).devices;
    expect(provider?.provides.slow?.tick).toEqual({ kind: "event", emitted: 200, dropped: 180 });
  });
});
