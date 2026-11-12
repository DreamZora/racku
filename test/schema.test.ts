/**
 * Tests for the Standard Schema helpers.
 *
 * @decision .agents/decisions/261112_035942-rack-architecture.md#basic-units
 */
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { z } from "zod";
import { formatIssues, isStandardSchema, type StandardSchemaV1, validate } from "../src/schema.ts";

// zod is the "other library": connectors must not depend on valibot.
// @decision .agents/decisions/261112_043033-p0-scope-and-toolchain.md#toolchain-and-dependencies
describe("validate", () => {
  test("returns the parsed output of a valibot schema", async () => {
    expect(await validate(v.pipe(v.string(), v.trim()), "  kv  ")).toEqual({
      ok: true,
      value: "kv",
    });
  });

  test("returns the parsed output of a zod schema", async () => {
    const schema = z.string().transform((text) => text.length);
    expect(await validate(schema, "abc")).toEqual({ ok: true, value: 3 });
  });

  const nested: Array<[string, StandardSchemaV1]> = [
    ["valibot", v.object({ user: v.object({ name: v.string() }) })],
    ["zod", z.object({ user: z.object({ name: z.string() }) })],
  ];
  test.each(nested)("prefixes %s issues with their path", async (_library, schema) => {
    const result = await validate(schema, { user: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toStartWith("user.name: ");
  });

  test("awaits schemas that validate asynchronously", async () => {
    const schema = z.string().refine(async (text) => text.length > 2, "too short");
    expect(await validate(schema, "ab")).toEqual({ ok: false, message: "too short" });
    expect(await validate(schema, "abc")).toEqual({ ok: true, value: "abc" });
  });
});

describe("formatIssues", () => {
  test("puts every issue on one line, each prefixed by its path", () => {
    const issues: StandardSchemaV1.Issue[] = [
      { message: "Required", path: ["user", { key: "name" }] },
      { message: "Too short" },
      { message: "Not a number", path: ["items", 0] },
    ];
    expect(formatIssues(issues)).toBe("user.name: Required; Too short; items.0: Not a number");
  });
});

describe("isStandardSchema", () => {
  test("accepts valibot and zod schemas", () => {
    expect(isStandardSchema(v.string())).toBe(true);
    expect(isStandardSchema(z.string())).toBe(true);
  });

  test("accepts a callable schema", () => {
    // Some libraries, such as ArkType, make schemas callable.
    const schema = Object.assign(() => undefined, {
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
    });
    expect(isStandardSchema(schema)).toBe(true);
  });

  test("rejects values without a ~standard validate function", () => {
    const values = [null, undefined, "schema", 1, {}, { "~standard": {} }, { "~standard": 1 }];
    for (const value of values) expect(isStandardSchema(value)).toBe(false);
  });
});
