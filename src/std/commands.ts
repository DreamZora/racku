/**
 * The commands connector, `commands/v1`, through which a device offers calls of its own that
 * hosts discover: `list()` describes each command, with JSON Schemas of its input and output
 * where its schemas give them, and `run()` runs one by name. `commands()` implements it from a
 * table of commands, and validates each command's input and output.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#the-commands-connector
 */
import * as v from "valibot";
import { connector, rpc } from "../connector.ts";
import type { CallContext, PortImpl } from "../device.ts";
import { RackError } from "../errors.ts";
import { formatIssues, isStandardSchema, type StandardSchemaV1 } from "../schema.ts";

/** The most commands that one device offers. */
const LIMIT = 256;

/** A command's name: 1 to 64 letters, digits, `.`, `_`, and `-`, from a letter. */
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

const JsonSchema = v.record(v.string(), v.unknown());

const CommandInfoSchema = v.object({
  name: v.pipe(v.string(), v.regex(NAME)),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  input: v.optional(JsonSchema),
  output: v.optional(JsonSchema),
});

/**
 * One command, as `list()` describes it: its name, an optional title and description, and the
 * JSON Schemas, draft 2020-12, of its input and output, when its schemas give them.
 */
export type CommandInfo = v.InferOutput<typeof CommandInfoSchema>;

/** `commands/v1`: the commands that a device offers, and a way to run each by name. */
export const Commands = connector("commands/v1", {
  /** The device's commands. They stay the same while its instance runs. */
  list: rpc(v.undefined(), v.pipe(v.array(CommandInfoSchema), v.maxLength(LIMIT))),
  /**
   * Runs one command with its input, and answers with its output. Fails with `RACK_NO_ROUTE`
   * for a name that the device doesn't offer, and with `RACK_INVALID_INPUT` or
   * `RACK_INVALID_OUTPUT` for input or output that fails the command's schema.
   */
  run: rpc(v.object({ name: v.string(), input: v.unknown() }), v.unknown()),
});

/** One command of {@link commands}, whose `input` is the Standard Schema of its input. */
export interface Command<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** A short name for people, such as for a button. */
  title?: string;
  description?: string;
  /** The schema of its input, which validates the input before `run()` gets it. */
  input: S;
  /** The schema of its output, which validates what `run()` returns; none checks nothing. */
  output?: StandardSchemaV1;
  /**
   * Runs the command.
   *
   * @param input The input, as the schema gave it.
   * @param call The call, with its signal and deadline.
   */
  run(input: StandardSchemaV1.InferOutput<S>, call: CallContext): unknown;
}

/**
 * Implements `commands/v1` from a table of commands, by name: `list()` describes them, with a
 * JSON Schema for each schema that implements Standard JSON Schema, and `run()` validates the
 * input, runs the command, and validates its output.
 *
 * @param table The commands, by name.
 * @returns The implementation of a port of `Commands`, for `powerOn` to return.
 * @throws RackError `RACK_INVALID_INPUT` for more than 256 commands, a name that isn't one, or
 *   a command whose schemas or `run` are missing; the device then fails to power on.
 */
export function commands<T extends Record<string, StandardSchemaV1>>(
  table: {
    readonly [K in keyof T]: Command<T[K]>;
  },
): PortImpl<(typeof Commands)["members"]> {
  const entries = Object.entries(table) as [string, Command][];
  if (entries.length > LIMIT) {
    throw new RackError(
      "RACK_INVALID_INPUT",
      `commands(): ${entries.length} commands, more than ${LIMIT}`,
    );
  }
  for (const [name, command] of entries) {
    if (!NAME.test(name)) {
      throw new RackError("RACK_INVALID_INPUT", `commands(): "${name}" must match ${NAME.source}`);
    }
    const valid =
      typeof command === "object" &&
      command !== null &&
      isStandardSchema(command.input) &&
      (command.output === undefined || isStandardSchema(command.output)) &&
      typeof command.run === "function";
    if (!valid) {
      throw new RackError(
        "RACK_INVALID_INPUT",
        `commands(): ${name} needs an input schema, a function run, and an output schema if any`,
      );
    }
  }
  const described = entries.map(([name, command]): CommandInfo => {
    const info: CommandInfo = { name };
    if (command.title !== undefined) info.title = command.title;
    if (command.description !== undefined) info.description = command.description;
    const input = jsonSchemaOf(command.input, "input");
    if (input !== undefined) info.input = input;
    const output =
      command.output === undefined ? undefined : jsonSchemaOf(command.output, "output");
    if (output !== undefined) info.output = output;
    return info;
  });
  const byName = new Map(entries);
  return {
    list: () => described,
    run: async ({ name, input }, call) => {
      const command = byName.get(name);
      if (command === undefined) throw new RackError("RACK_NO_ROUTE", `no command ${name}`);
      const parsed = await check(command.input, input, "RACK_INVALID_INPUT", `${name}: input`);
      const output = await command.run(parsed, call);
      if (command.output === undefined) return output;
      return check(command.output, output, "RACK_INVALID_OUTPUT", `${name}: output`);
    },
  };
}

/**
 * The JSON Schema that a schema gives through Standard JSON Schema, as plain data, or
 * `undefined` for a schema that implements none, or that has none for draft 2020-12.
 */
function jsonSchemaOf(
  schema: StandardSchemaV1,
  which: "input" | "output",
): Record<string, unknown> | undefined {
  const standard = schema["~standard"] as { jsonSchema?: Record<string, unknown> };
  const convert = standard.jsonSchema?.[which];
  if (typeof convert !== "function") return undefined;
  try {
    const result: unknown = convert({ target: "draft-2020-12" });
    if (typeof result !== "object" || result === null) return undefined;
    return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  } catch {
    // A schema with no JSON Schema in this draft gets none, and the command runs all the same.
    return undefined;
  }
}

/** Validates a command's input or output, failing with the code and the issues as data. */
async function check(
  schema: StandardSchemaV1,
  value: unknown,
  code: "RACK_INVALID_INPUT" | "RACK_INVALID_OUTPUT",
  where: string,
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues === undefined) return result.value;
  const issues = result.issues.map((issue) => ({
    message: issue.message,
    path: issue.path?.map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "symbol" ? String(key) : key;
    }),
  }));
  throw new RackError(code, `${where}: ${formatIssues(result.issues)}`, { issues });
}
