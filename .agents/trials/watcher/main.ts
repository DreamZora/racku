import { launch } from "./app.ts";

const app = await launch({
  watchFile: new URL("./watch.json", import.meta.url).pathname,
  port: Number(process.env.PORT ?? 3000),
  baseDir: import.meta.dir,
});
const quit = () => void app.stop().then(() => process.exit(0));
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
