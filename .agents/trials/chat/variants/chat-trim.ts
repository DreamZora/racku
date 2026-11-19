import { device } from "rack42u";
import { Http } from "rack42u/std";
import { History } from "../connectors.ts";
import { chatHandler } from "../devices/chat-core.ts";

// A changed version of the chat device: it trims the text of every message.
let handler: ReturnType<typeof chatHandler> | undefined;

export default device({
  model: "chat",
  needs: { history: History },
  provides: { http: Http },

  powerOn(ctx) {
    handler = chatHandler(ctx, (text) => text.trim());
    return { http: handler };
  },

  snapshot: () => handler?.list() ?? [],
  restore(_ctx, state) {
    handler?.restore(state as never);
  },
});
