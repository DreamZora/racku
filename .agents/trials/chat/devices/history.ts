import { device } from "rack42u";
import * as v from "valibot";
import { History, Message } from "../connectors.ts";

const MAX_ROOMS = 1000;
const KEEP = 20;

let state: Map<string, Message[]> | undefined;

export default device({
  model: "history",
  provides: { history: History },

  powerOn() {
    // Insertion order of the map is the age of a room's last message.
    const rooms = new Map<string, Message[]>();
    state = rooms;
    return {
      history: {
        add(message) {
          const list = rooms.get(message.room) ?? [];
          rooms.delete(message.room);
          list.push(message);
          if (list.length > KEEP) list.splice(0, list.length - KEEP);
          rooms.set(message.room, list);
          if (rooms.size > MAX_ROOMS) rooms.delete(rooms.keys().next().value!);
        },
        recent({ room, limit }) {
          return (rooms.get(room) ?? []).slice(-Math.max(0, limit));
        },
      },
    };
  },

  snapshot: () => ({ rooms: [...(state?.entries() ?? [])] }),
  restore(_ctx, snapshot) {
    const parsed = v.safeParse(v.object({ rooms: v.array(v.tuple([v.string(), v.array(Message)])) }), snapshot);
    if (parsed.success && state) for (const [room, list] of parsed.output.rooms) state.set(room, list);
  },
});
