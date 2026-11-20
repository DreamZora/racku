import { readFileSync } from "node:fs";
import { buildRack, parseWatch, portFromEnv } from "./layout.ts";

// For `rack start`; main.ts starts the same rack and also follows watch.json while it runs.
export default buildRack(
  parseWatch(readFileSync(new URL("./watch.json", import.meta.url), "utf8")),
  new Map(),
  portFromEnv(),
);
