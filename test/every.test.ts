/**
 * Tests of every needs: a need for every device below that provides a connector, by name, which
 * follows the devices that come, go, and swap, and whose events carry the emitter's name.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rack, slot } from "rack42u";
import {
  codeOf,
  errorOf,
  type TempApp,
  type TestRack,
  tempApp,
  useRacks,
  waitFor,
} from "./fixtures/app.ts";

const startRack = useRacks();

const apps: TempApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

const CONNECTORS = `import { connector, event, rpc } from "rack42u";
import * as v from "valibot";

/** What every tool does: turn a text into another. */
export const Tool = connector("test.tool/v1", {
  run: rpc(v.string(), v.string()),
  ran: event(v.object({ text: v.string() })),
});

/** The host's port, through which a test sees what its every need reaches. */
export const Host = connector("test.host/v1", {
  names: rpc(v.undefined(), v.array(v.string())),
  firmware: rpc(v.string(), v.nullable(v.string())),
  run: rpc(v.object({ tool: v.string(), text: v.string() }), v.string()),
  heard: rpc(v.undefined(), v.array(v.string())),
  changes: rpc(v.undefined(), v.number()),
  flood: rpc(
    v.object({ tool: v.string(), count: v.number(), other: v.string() }),
    v.object({ codes: v.array(v.string()), answer: v.string() }),
  ),
});
`;

/** A tool whose `run` answers with `expression`, of `text`, and emits `ran` with it. */
function tool(model: string, expression: string, extra = ""): string {
  return `import { device } from "rack42u";
import { Tool } from "../connectors.ts";

export default device({
  model: "${model}",${extra}
  provides: { tool: Tool },
  powerOn: (ctx) => ({
    tool: {
      run: async (text) => {
        const out = ${expression};
        await ctx.emit.tool.ran({ text: out });
        return out;
      },
    },
  }),
});
`;
}

const HOST = `import { device, every, RackError } from "rack42u";
import { Host, Tool } from "../connectors.ts";

const heard: string[] = [];
let changes = 0;

export default device({
  model: "host",
  needs: { tools: every(Tool) },
  provides: { host: Host },
  powerOn(ctx) {
    ctx.on.tools.ran(({ text }, from) => {
      heard.push(from + ":" + text);
    });
    ctx.ports.tools.changed(() => {
      changes++;
      if (changes === 1_000_000) throw new Error("never");
    });
    return {
      host: {
        names: () => ctx.ports.tools.list().map((device) => device.name),
        firmware: (name) => ctx.ports.tools.list().find((device) => device.name === name)?.firmware ?? null,
        run: async ({ tool, text }) => {
          const port = ctx.ports.tools.get(tool);
          if (port === undefined) throw new RackError("NO_TOOL", "no tool " + tool);
          return port.run(text, { timeout: 1_000 });
        },
        heard: () => heard,
        changes: () => changes,
        // Calls one tool count times at once, and another while those wait.
        flood: async ({ tool, count, other }) => {
          const port = ctx.ports.tools.get(tool);
          if (port === undefined) throw new RackError("NO_TOOL", "no tool " + tool);
          const codes = Array.from({ length: count }, () =>
            port.run("x", { timeout: 1_000 }).then(
              () => "ok",
              (error) => error.code,
            ),
          );
          const answer = (await ctx.ports.tools.get(other)?.run("Hi")) ?? "";
          return { codes: await Promise.all(codes), answer };
        },
      },
    };
  },
});
`;

/** A temp app with the connectors, the host, and tools named upper, lower, and twice. */
async function toolApp(): Promise<TempApp> {
  const app = await tempApp();
  apps.push(app);
  await app.write("connectors.ts", CONNECTORS);
  await app.write("devices/host.ts", HOST);
  await app.write("devices/upper.ts", tool("upper", "text.toUpperCase()"));
  await app.write("devices/lower.ts", tool("lower", "text.toLowerCase()"));
  await app.write("devices/twice.ts", tool("twice", "text + text"));
  return app;
}

const host = (running: TestRack["running"]) => ({
  names: () => running.call("host.host", "names", undefined),
  run: (tool: string, text: string) => running.call("host.host", "run", { tool, text }),
  heard: () => running.call("host.host", "heard", undefined),
  changes: () => running.call("host.host", "changes", undefined) as Promise<number>,
  firmware: (name: string) => running.call("host.host", "firmware", name),
});

describe("every needs in a rack placed by hand", () => {
  test("reach every device below that provides the connector, in slot order, and call each by name", async () => {
    const app = await toolApp();
    const { running } = await startRack(
      {
        slots: {
          1: slot("./devices/upper.ts"),
          2: slot("./devices/lower.ts"),
          3: slot("./devices/host.ts"),
          4: slot("./devices/twice.ts"),
        },
      },
      { baseDir: app.dir },
    );
    const h = host(running);
    // twice sits above the host, so the need doesn't reach it.
    expect(await h.names()).toEqual(["upper", "lower"]);
    expect(await h.run("upper", "Hi")).toBe("HI");
    expect(await h.run("lower", "Hi")).toBe("hi");
    expect(await codeOf(h.run("twice", "Hi"))).toBe("NO_TOOL");
    // Events arrive with the name of the device that emitted them.
    await waitFor(async () => ((await h.heard()) as string[]).length === 2);
    expect(await h.heard()).toEqual(["upper:HI", "lower:hi"]);
    // metrics() counts the calls of the need as one need's.
    const metrics = await running.metrics();
    const needs = metrics.devices.find((d) => d.device === "host")?.needs.tools;
    expect((needs?.run as { calls: number } | undefined)?.calls).toBe(2);
  });

  test("follow plug(), unplug(), and swaps below, and tell changed() each time", async () => {
    const app = await toolApp();
    const { running } = await startRack(
      { slots: { 1: slot("./devices/upper.ts"), 3: slot("./devices/host.ts") } },
      { baseDir: app.dir },
    );
    const h = host(running);
    expect(await h.names()).toEqual(["upper"]);
    const before = await h.changes();
    await running.plug(2, slot("./devices/lower.ts"));
    expect(await h.names()).toEqual(["upper", "lower"]);
    expect(await h.run("lower", "Hi")).toBe("hi");
    expect(await h.changes()).toBe(before + 1);
    // A swap to other firmware keeps the name, and changed() reports the new firmware.
    const old = await h.firmware("upper");
    await app.write("devices/upper.ts", tool("upper", '"<" + text.toUpperCase() + ">"'));
    await running.swap("upper");
    expect(await h.run("upper", "Hi")).toBe("<HI>");
    expect(await h.firmware("upper")).not.toBe(old);
    expect(await h.changes()).toBe(before + 2);
    await running.unplug("upper");
    expect(await h.names()).toEqual(["lower"]);
    expect(await codeOf(h.run("upper", "Hi"))).toBe("NO_TOOL");
    expect(await h.changes()).toBe(before + 3);
    // The host kept running through all of it.
    expect(running.status().find((s) => s.name === "host")?.state).toBe("online");
  });

  test("a device that provides the connector on several ports isn't reached, and the log warns", async () => {
    const app = await toolApp();
    await app.write(
      "devices/both.ts",
      `import { device } from "rack42u";
import { Tool } from "../connectors.ts";
const impl = { run: (text: string) => text };
export default device({ model: "both", provides: { a: Tool, b: Tool }, powerOn: () => ({ a: impl, b: impl }) });
`,
    );
    const { running, rec } = await startRack(
      {
        slots: {
          1: slot("./devices/both.ts"),
          2: slot("./devices/upper.ts"),
          3: slot("./devices/host.ts"),
        },
      },
      { baseDir: app.dir },
    );
    expect(await host(running).names()).toEqual(["upper"]);
    expect(rec.logs.map((entry) => entry.message)).toContain(
      "host.tools doesn't reach both, which provides test.tool/v1 on several ports",
    );
  });

  test("a patch for an every need fails the manifest", async () => {
    const app = await toolApp();
    const error = await errorOf(
      startRack(
        {
          slots: { 1: slot("./devices/upper.ts"), 2: slot("./devices/host.ts") },
          patch: [["host.tools", "upper.tool"]],
        },
        { baseDir: app.dir },
      ),
    );
    expect([error.code, error.message]).toEqual([
      "RACK_MANIFEST",
      expect.stringContaining("host.tools is an every need"),
    ]);
  });

  test("calls to one device wait for its own bound, and calls to the others go on", async () => {
    const app = await toolApp();
    // A tool that answers no call, and ends each one only when the call is cancelled.
    await app.write(
      "devices/stuck.ts",
      `import { device } from "rack42u";
import { Tool } from "../connectors.ts";
export default device({
  model: "stuck",
  provides: { tool: Tool },
  powerOn: () => ({
    tool: {
      run: (_text, call) =>
        new Promise<string>((_resolve, reject) => {
          call.signal.addEventListener("abort", () => reject(call.signal.reason));
        }),
    },
  }),
});
`,
    );
    const { running } = await startRack(
      {
        slots: {
          1: slot("./devices/stuck.ts"),
          2: slot("./devices/upper.ts"),
          3: slot("./devices/host.ts"),
        },
      },
      { baseDir: app.dir, queueLimit: 2 },
    );
    // Of three calls at once to stuck, two wait until the host's timeout ends them, and the
    // third finds stuck's bound full; a call to upper meanwhile has a bound of its own.
    const flooded = await running.call("host.host", "flood", {
      tool: "stuck",
      count: 3,
      other: "upper",
    });
    expect(flooded).toEqual({
      codes: ["RACK_TIMEOUT", "RACK_TIMEOUT", "RACK_OVERLOADED"],
      answer: "HI",
    });
  }, 15_000);
});

describe("every needs in a scanned rack", () => {
  test("place what they reach below the device, start nothing, and see devices that the plan starts", async () => {
    const app = await toolApp();
    const scanned = (roots: string[]) =>
      startRack({ devices: ["./devices"], roots }, { baseDir: app.dir, plan: false });
    // The tools are neither roots nor needed, so the every need reaches none of them.
    const alone = await scanned(["host"]);
    expect(await host(alone.running).names()).toEqual([]);
    await alone.running.stop();
    const all = await scanned(["host", "upper", "twice"]);
    expect(all.running.status().map((s) => s.name)).toEqual(["twice", "upper", "host"]);
    expect(await host(all.running).names()).toEqual(["twice", "upper"]);
  });

  test("a device that the every need reaches and that needs the host is a cycle", async () => {
    const app = await toolApp();
    await app.write(
      "devices/loop.ts",
      tool("loop", "text", "\n  needs: { host: Host },").replace(
        'import { Tool } from "../connectors.ts";',
        'import { Host, Tool } from "../connectors.ts";',
      ),
    );
    const error = await errorOf(
      startRack(
        { devices: ["./devices"], roots: ["host", "loop"] },
        { baseDir: app.dir, plan: false },
      ),
    );
    expect([error.code, error.message]).toEqual(["RACK_MANIFEST", "cycle: host → loop → host"]);
  });

  test("a use entry for an every need fails the manifest", async () => {
    const app = await toolApp();
    const error = await errorOf(
      startRack(
        { devices: ["./devices"], roots: ["host"], use: { "host.tools": "upper" } },
        { baseDir: app.dir, plan: false },
      ),
    );
    expect(error.message).toContain("use host.tools: an every need reaches every provider");
  });

  test("a reload that adds a root plugs it below the host, whose every need then reaches it", async () => {
    const app = await toolApp();
    const spec = (roots: string[]) => ({ devices: ["./devices"], roots });
    const { running } = await startRack(spec(["host", "upper"]), { baseDir: app.dir, plan: false });
    expect(await host(running).names()).toEqual(["upper"]);
    await running.reload(rack("test", spec(["host", "upper", "lower"])));
    expect(await host(running).names()).toEqual(["lower", "upper"]);
    expect(await host(running).run("lower", "Hi")).toBe("hi");
  });
});
