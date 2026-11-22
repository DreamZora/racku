/**
 * A device that offers commands through `commands/v1`, with Zod schemas, which give JSON
 * Schemas, a Valibot one, which gives none, and Valibot ones that `toStandardJsonSchema()` of
 * `@valibot/to-json-schema` makes give them.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#the-commands-connector
 */
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { device } from "racku";
import { Commands, commands } from "racku/std";
import * as v from "valibot";
import * as z from "zod";

export default device({
  model: "commander",
  provides: { commands: Commands },
  powerOn: () => ({
    commands: commands({
      upper: {
        title: "Upper case",
        description: "Upper-cases a text",
        input: z.object({ text: z.string() }),
        output: z.string(),
        run: ({ text }) => text.toUpperCase(),
      },
      count: { input: v.array(v.number()), run: (numbers) => numbers.length },
      shout: {
        input: toStandardJsonSchema(v.object({ text: v.string() })),
        output: toStandardJsonSchema(v.string()),
        run: ({ text }) => `${text.toUpperCase()}!`,
      },
      liar: { input: z.undefined(), output: z.number(), run: () => "not a number" },
    }),
  }),
});
