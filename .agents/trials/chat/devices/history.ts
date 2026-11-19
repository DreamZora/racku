import { device } from "rack42u";
import * as v from "valibot";
import { History, Message } from "../connectors.ts";

export const KEEP = 20;

const State = v.record(v.string(), v.array(Message));
let rooms: Record<string, v.InferOutput<typeof Message>[]> = {};

export default device({
  model: "history",
  provides: { history: History },

  powerOn() {
    return {
      history: {
        add(message) {
          const list = (rooms[message.room] ??= []);
          list.push(message);
          if (list.length > KEEP) list.splice(0, list.length - KEEP);
        },
        recent: (room) => [...(rooms[room] ?? [])],
      },
    };
  },

  snapshot: () => rooms,
  restore(_ctx, state) {
    const parsed = v.safeParse(State, state);
    if (parsed.success) rooms = parsed.output;
  },
});
