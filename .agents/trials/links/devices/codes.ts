import { device } from "rack42u";
import { Codes } from "../connectors.ts";

/** How many characters a code has. */
const LENGTH = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export default device({
  model: "link-codes",
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
