import { device, RackError } from "racku";
import { Commands, commands } from "racku/std";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

/** Rolls `count` dice of `sides` sides, such as "2d6". */
export function roll(text: string, random: () => number = Math.random): string {
  const m = /^\s*(\d{1,3})d(\d{1,6})\s*$/i.exec(text);
  if (!m) throw new RackError("BAD_DICE", "use NdM, such as 2d6");
  const count = Number(m[1]);
  const sides = Number(m[2]);
  if (count < 1 || sides < 1) throw new RackError("BAD_DICE", "use NdM, such as 2d6");
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(random() * sides));
  return `${rolls.join(" + ")} = ${rolls.reduce((a, b) => a + b, 0)}`;
}

export default device({
  model: "dice",
  provides: { commands: Commands },
  powerOn: () => ({
    commands: commands({
      roll: {
        description: "Rolls dice, such as 2d6",
        input: toStandardJsonSchema(v.string()),
        run: (text: string) => roll(text),
      },
    }),
  }),
});
