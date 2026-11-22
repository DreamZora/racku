import { rack, slot } from "racku";
import { httpPanel, sqlite } from "racku/std";

export default rack("links", {
  slots: {
    1: sqlite({ path: "data/links.db" }),
    2: slot("./devices/store.ts"),
    3: slot("./devices/codes.ts"),
    4: slot("./devices/api.ts"),
    5: httpPanel({
      port: Number(process.env.PORT ?? 3000),
      routes: {
        "/links": "api.http",
        "/links/:code": "api.http",
        "/:code": "api.http",
      },
    }),
  },
});
