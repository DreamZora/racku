import { device, every, RackError } from "racku";
import { Commands, Http, httpHandler } from "racku/std";
import { Filter } from "../connectors.ts";

const CALL_TIMEOUT = 8_000;

const json = (status: number, body: unknown) => Response.json(body, { status });

export default device({
  model: "bot",
  needs: { commands: every(Commands), filters: every(Filter) },
  provides: { http: Http },

  powerOn: (ctx) => {
    /** Every command of every plugin that offers any, with the plugin's name. */
    async function listCommands() {
      const out: { name: string; plugin: string; description: string; schema: unknown }[] = [];
      await Promise.all(
        ctx.ports.commands.list().map(async (entry) => {
          try {
            const list = await ctx.ports.commands.get(entry.name)?.list(undefined, { timeout: 2_000 });
            for (const c of list ?? []) {
              out.push({
                name: c.name,
                plugin: entry.name,
                description: c.description ?? "",
                schema: c.input ?? {},
              });
            }
          } catch (error) {
            ctx.log.warn("plugin failed to list its commands", { plugin: entry.name, error: String(error) });
          }
        }),
      );
      return out;
    }

    async function message(request: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "the body is not JSON" });
      }
      const b = body as { user?: unknown; text?: unknown } | null;
      if (typeof b !== "object" || b === null || typeof b.user !== "string" || typeof b.text !== "string") {
        return json(400, { error: "`user` and `text` must be strings" });
      }
      const msg = { user: b.user, text: b.text };

      for (const entry of ctx.ports.filters.list()) {
        try {
          const verdict = await ctx.ports.filters.get(entry.name)?.check(msg, { timeout: 2_000 });
          if (verdict && !verdict.ok) {
            return json(403, { error: verdict.reason ?? `refused by ${entry.name}` });
          }
        } catch (error) {
          ctx.log.warn("filter plugin failed, skipped", { plugin: entry.name, error: String(error) });
        }
      }

      if (!msg.text.startsWith("/")) return json(200, { reply: null });
      const match = /^\/(\S*)\s?([\s\S]*)$/.exec(msg.text);
      const name = match?.[1] ?? "";
      const argument = match?.[2] ?? "";

      for (const entry of ctx.ports.commands.list()) {
        const port = ctx.ports.commands.get(entry.name);
        let offered: { name: string }[] = [];
        try {
          offered = (await port?.list(undefined, { timeout: 2_000 })) ?? [];
        } catch (error) {
          ctx.log.warn("plugin failed to list its commands", { plugin: entry.name, error: String(error) });
          continue;
        }
        if (!offered.some((c) => c.name === name)) continue;
        try {
          const reply = await port?.run({ name, input: argument }, { timeout: CALL_TIMEOUT });
          return json(200, { reply: typeof reply === "string" ? reply : JSON.stringify(reply) });
        } catch (error) {
          const code = error instanceof RackError ? error.code : "";
          ctx.log.warn("plugin command failed", { plugin: entry.name, command: name, code, error: String(error) });
          if (code === "RACK_TIMEOUT") return json(504, { error: `command /${name} of ${entry.name} timed out` });
          if (code === "RACK_INVALID_INPUT") return json(400, { error: `bad argument for /${name}` });
          // A code of the plugin's own: the command refused its argument.
          if (code !== "" && !code.startsWith("RACK_")) return json(400, { error: (error as Error).message });
          return json(500, { error: `command /${name} of ${entry.name} failed` });
        }
      }
      return json(404, { error: `unknown command /${name}` });
    }

    return {
      http: httpHandler(async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/commands" && request.method === "GET") return json(200, await listCommands());
        if (path === "/messages" && request.method === "POST") return message(request);
        return json(405, { error: "method not allowed" });
      }),
    };
  },
});
