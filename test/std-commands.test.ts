/**
 * Tests of `commands/v1` and `commands()`: the list of a device's commands, with JSON Schemas
 * where its schemas give them, and runs that validate each command's input and output.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#the-commands-connector
 */
import { describe, expect, test } from "bun:test";
import { slot } from "racku";
import { commands } from "racku/std";
import * as z from "zod";
import { errorOf, useRacks } from "./fixtures/app.ts";

const startRack = useRacks();

// @doc docs/reference/api.md#commands
// @doc docs/guides/hotplug.md#commands
describe("the commands connector", () => {
  test("list() describes each command, with the JSON Schemas that its schemas give", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/commander.ts") } });
    expect(await running.call("commander.commands", "list", undefined)).toEqual([
      {
        name: "upper",
        title: "Upper case",
        description: "Upper-cases a text",
        input: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        output: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" },
      },
      // A Valibot schema implements no Standard JSON Schema, so the command has none.
      { name: "count" },
      // toStandardJsonSchema() of @valibot/to-json-schema makes Valibot's schemas give theirs.
      {
        name: "shout",
        input: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        output: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" },
      },
      // Zod has no JSON Schema for undefined, and throws, so the input gets none.
      {
        name: "liar",
        output: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "number" },
      },
    ]);
  });

  test("run() validates the input and the output of a command, and refuses a name it doesn't offer", async () => {
    const { running } = await startRack({ slots: { 1: slot("./devices/commander.ts") } });
    const run = (name: string, input: unknown) =>
      running.call("commander.commands", "run", { name, input });
    expect(await run("upper", { text: "hi" })).toBe("HI");
    expect(await run("count", [1, 2, 3])).toBe(3);
    expect(await run("shout", { text: "hi" })).toBe("HI!");
    expect((await errorOf(run("shout", { text: 1 }))).code).toBe("RACK_INVALID_INPUT");
    const input = await errorOf(run("upper", { text: 1 }));
    expect([input.code, input.message]).toEqual([
      "RACK_INVALID_INPUT",
      expect.stringContaining("upper: input: text:"),
    ]);
    expect(input.data).toEqual({ issues: [{ message: expect.any(String), path: ["text"] }] });
    expect((await errorOf(run("liar", undefined))).code).toBe("RACK_INVALID_OUTPUT");
    expect((await errorOf(run("nothing", undefined))).code).toBe("RACK_NO_ROUTE");
  });

  // @doc docs/reference/limits.md#hot-plug-devices
  test("commands() refuses more than 256 commands, a name that isn't one, and a command without schemas or run", () => {
    const one = { input: z.string(), run: (text: string) => text };
    const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`c${i}`, one]));
    expect(() => commands(many)).toThrow("257 commands, more than 256");
    expect(() => commands({ "1st": one })).toThrow('"1st" must match');
    expect(() => commands({ bad: { run: () => 1 } as never })).toThrow("needs an input schema");
  });
});
