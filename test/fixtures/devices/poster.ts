import { device } from "racku";
import { Counter } from "../connectors.ts";

/** Posts on its Worker's own channel, as device code can, where the Worker host posts too. */
const post = (message: unknown) =>
  (globalThis as unknown as { postMessage(message: unknown): void }).postMessage(message);

let n = 0;

export default device({
  model: "poster",
  provides: { counter: Counter },
  powerOn: () => ({
    counter: {
      inc: () => {
        post("not a message of the Worker host");
        return ++n;
      },
      slowInc: () => {
        post({ op: "log", level: "loud", message: 42 });
        post({ id: "seven", ok: false });
        return ++n;
      },
      get: () => ({ n, firmware: "", version: "" }),
    },
  }),
});
