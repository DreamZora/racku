import { rack, slot } from "rack42u";
import { httpPanel, sqlite } from "rack42u/std";

export default rack("links", {
  slots: {
    1: sqlite({ path: "data/links.db" }),
    2: slot("./devices/store.ts"),
    3: slot("./devices/codes.ts"),
    4: slot("./devices/web.ts"),
    5: httpPanel({
      port: Number(process.env.PORT ?? 3000),
      routes: { "/links": "links-web.http", "/links/:code": "links-web.http", "/:code": "links-web.http" },
    }),
  },
});
