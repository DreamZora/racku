import { device } from "rack42u";
import { Http } from "rack42u/std";
import { History } from "../connectors.ts";
import { chatHandler } from "./chat-core.ts";

export default device({
  model: "chat",
  needs: { history: History },
  provides: { http: Http },

  powerOn(ctx) {
    const http = chatHandler(ctx);
    // `ref` lets snapshot and restore reach the handler of this instance.
    handler = http;
    return { http };
  },

  snapshot: () => handler?.list() ?? [],
  restore(_ctx, state) {
    handler?.restore(state as never);
  },
});

let handler: ReturnType<typeof chatHandler> | undefined;
