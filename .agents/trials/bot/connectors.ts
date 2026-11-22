import { connector, rpc } from "racku";
import * as v from "valibot";

export const MessageIn = v.object({ user: v.string(), text: v.string() });

/** Extension point: a plugin that filters messages. `ok: false` refuses with `reason`. */
export const Filter = connector("bot.filter/v1", {
  check: rpc(MessageIn, v.object({ ok: v.boolean(), reason: v.optional(v.string()) })),
});
