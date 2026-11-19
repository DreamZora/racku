import { rack, slot } from "rack42u";
import { httpPanel } from "rack42u/std";

export default rack("chat", {
  slots: {
    1: slot("./devices/history.ts"),
    2: slot("./devices/chat.ts"),
    3: httpPanel({
      port: Number(process.env.PORT ?? 3000),
      routes: { "/chat": "chat.http", "/rooms": "chat.http" },
    }),
  },
});
