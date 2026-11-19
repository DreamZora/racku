/**
 * A Worker that imports each bundle a test names with `importFirmware`, as the Worker host does,
 * and answers with the bundle's default export, or with the error, and the attempts it took.
 */
import { importFirmware } from "../../src/firmware.ts";

addEventListener("message", async (event: MessageEvent<string>) => {
  let attempts = 0;
  const load = (url: string): Promise<unknown> => {
    attempts++;
    return import(url);
  };
  try {
    const module = (await importFirmware(event.data, load)) as { default?: unknown };
    postMessage({ ok: true, value: module.default, attempts });
  } catch (error) {
    postMessage({ ok: false, error: String(error), attempts });
  }
});
