import { device } from "racku";
import * as v from "valibot";
import { History, Message } from "../connectors.ts";

const KEEP = 20;

let rooms = new Map<string, Message[]>();

const State = v.array(v.tuple([v.string(), v.array(Message)]));

export default device({
  model: "history",
  provides: { history: History },

  powerOn: () => ({
    history: {
      add(message) {
        const list = rooms.get(message.room) ?? [];
        list.push(message);
        if (list.length > KEEP) list.splice(0, list.length - KEEP);
        rooms.set(message.room, list);
      },
      recent: ({ room }) => [...(rooms.get(room) ?? [])],
    },
  }),

  snapshot: () => [...rooms],
  restore(_ctx, state) {
    const parsed = v.safeParse(State, state);
    if (parsed.success) rooms = new Map(parsed.output);
  },
});
