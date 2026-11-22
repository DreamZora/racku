import { rack, slot } from "racku";
import { httpPanel } from "racku/std";

export default rack("files", {
  slots: {
    1: slot("./devices/store.ts", { config: { dir: process.env.FILES_DIR ?? "data/files" } }),
    2: slot("./devices/web.ts"),
    3: httpPanel({
      port: Number(process.env.PORT ?? 3000),
      maxBodySize: 50 * 1024 * 1024,
      routes: { "/files": "web.http", "/files/:name": "web.http" },
    }),
  },
});
