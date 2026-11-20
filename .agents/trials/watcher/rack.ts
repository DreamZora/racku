import { layout, readWatch } from "./watcher.ts";

// The manifest as of the start; `bun run start` runs watcher.ts instead, which also follows watch.json.
export default layout(readWatch(new URL("./watch.json", import.meta.url).pathname), Number(process.env.PORT ?? 3000));
