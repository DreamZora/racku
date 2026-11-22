import { readFileSync } from "node:fs";
import { device } from "racku";
import { Located } from "../connectors.ts";
import { helperPaths } from "./_located/where.ts";

/** The `import.meta` paths of this file, which its firmware keeps. */
const devicePaths = {
  url: import.meta.url,
  dir: import.meta.dir,
  dirname: import.meta.dirname,
  path: import.meta.path,
  filename: import.meta.filename,
};

/** Reports where its firmware thinks it lies, and reads a file next to its source. */
export default device({
  model: "located",
  provides: { located: Located },
  powerOn: () => ({
    located: {
      where: () => ({
        device: devicePaths,
        helper: helperPaths,
        text: readFileSync(new URL("./_located/greeting.txt", import.meta.url), "utf8"),
      }),
    },
  }),
});
