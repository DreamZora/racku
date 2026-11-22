import { device } from "racku";
import { Filter } from "../connectors.ts";

const WORDS = ["badword", "spam", "forbidden"];

/** The first listed word that the text holds, as a whole word, or undefined. */
export function findWord(text: string, words: string[] = WORDS): string | undefined {
  const held = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
  return words.find((w) => held.includes(w.toLowerCase()));
}

export default device({
  model: "wordfilter",
  provides: { filter: Filter },
  powerOn: () => ({
    filter: {
      check: ({ text }) => {
        const word = findWord(text);
        return word === undefined ? { ok: true } : { ok: false, reason: `the word "${word}" is not allowed` };
      },
    },
  }),
});
