import { device } from "racku";
import { Codes } from "../connectors.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LENGTH = 6;

export default device({
  model: "codes",
  provides: { codes: Codes },
  powerOn: () => ({
    codes: {
      make() {
        const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
        return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
      },
    },
  }),
});
