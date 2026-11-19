import { rack, slot } from "rack42u";

// The environment names the port and the directory of the files, so that a check can use its own.
const port = Number(process.env.PORT ?? 3000);
const dir = process.env.FILES_DIR ?? "data/files";

export default rack("files", {
  slots: {
    1: slot("./devices/store.ts", { config: { dir } }),
    2: slot("./devices/web.ts", { config: { port } }),
  },
});
