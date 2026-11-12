/**
 * Standard Schema helpers shared by connectors, device config, and the rack.
 *
 * Connectors accept any library that implements Standard Schema, so validation goes
 * through the `~standard` interface instead of a specific library.
 *
 * @decision .agents/decisions/261112_035942-rack-architecture.md#basic-units
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type { StandardSchemaV1 };

/** Result of {@link validate}: the parsed value or a readable issue summary. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Validates a value against a Standard Schema.
 *
 * @param schema Any Standard Schema implementation (valibot, zod, arktype, ...).
 * @param value The value to validate.
 * @returns The parsed output on success, or a message listing the issues.
 */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues === undefined) return { ok: true, value: result.value };
  return { ok: false, message: formatIssues(result.issues) };
}

/**
 * Formats Standard Schema issues on one line: each issue is prefixed by its path, and issues
 * are separated by `; `.
 *
 * @param issues Issues reported by a schema.
 * @returns A human-readable summary, for example `user.name: Required; Too short`.
 */
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues
    .map((issue) => {
      const path = issue.path
        ?.map((segment) => (typeof segment === "object" ? segment.key : segment))
        .join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Reports whether a value implements Standard Schema.
 *
 * @param value Any value.
 * @returns `true` when the value exposes a `~standard` object with a `validate` function.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const standard = (value as { "~standard"?: { validate?: unknown } })["~standard"];
  return typeof standard === "object" && typeof standard?.validate === "function";
}
