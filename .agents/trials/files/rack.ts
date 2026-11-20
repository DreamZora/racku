import { rack, slot } from "rack42u";

export default rack("files", {
  slots: {
    1: slot("./devices/files.ts", {
      config: {
        port: Number(process.env.PORT ?? 3000),
        // Only for checks, which keep their files apart from the app's own.
        ...(process.env.FILES_DIR ? { dir: process.env.FILES_DIR } : {}),
      },
    }),
  },
});
