import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Message = v.object({
  room: v.string(),
  user: v.string(),
  text: v.string(),
  at: v.number(),
});
export type Message = v.InferOutput<typeof Message>;

/** The recent messages of the rooms, kept apart from the device that handles messages. */
export const History = connector("chat.history/v1", {
  add: rpc(Message, v.undefined()),
  recent: rpc(v.object({ room: v.string(), limit: v.number() }), v.array(Message)),
});
