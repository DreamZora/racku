import { connector, rpc } from "racku";
import * as v from "valibot";

export const Message = v.object({
  room: v.string(),
  user: v.string(),
  text: v.string(),
  at: v.number(),
});
export type Message = v.InferOutput<typeof Message>;

/** The keeping of recent messages, by room. */
export const History = connector("chat-history/v1", {
  add: rpc(Message, v.undefined()),
  recent: rpc(v.object({ room: v.string() }), v.array(Message)),
});
