import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Message = v.object({
  room: v.string(),
  user: v.string(),
  text: v.string(),
  at: v.number(),
});

/** Recent messages of rooms. */
export const History = connector("chat.history/v1", {
  add: rpc(Message, v.undefined()),
  recent: rpc(v.string(), v.array(Message)),
});
