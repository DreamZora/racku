/**
 * Device files for tests of every needs and hot-plug directories: a connector of tools, tools
 * that answer with an expression of their input, and a host whose every need reaches them.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
 */
import type { RackHandle } from "rack42u";
import { type TempApp, tempApp } from "./app.ts";

export const CONNECTORS = `import { connector, event, rpc } from "rack42u";
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
export function tool(model: string, expression: string, extra = ""): string {
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

export const HOST = `import { device, every, RackError } from "rack42u";
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
export async function toolApp(apps: TempApp[]): Promise<TempApp> {
  const app = await tempApp();
  apps.push(app);
  await app.write("connectors.ts", CONNECTORS);
  await app.write("devices/host.ts", HOST);
  await app.write("devices/upper.ts", tool("upper", "text.toUpperCase()"));
  await app.write("devices/lower.ts", tool("lower", "text.toLowerCase()"));
  await app.write("devices/twice.ts", tool("twice", "text + text"));
  return app;
}

/** The host's calls, through its port. */
export const host = (running: RackHandle) => ({
  names: () => running.call("host.host", "names", undefined),
  run: (tool: string, text: string) => running.call("host.host", "run", { tool, text }),
  heard: () => running.call("host.host", "heard", undefined),
  changes: () => running.call("host.host", "changes", undefined) as Promise<number>,
  firmware: (name: string) => running.call("host.host", "firmware", name),
});
