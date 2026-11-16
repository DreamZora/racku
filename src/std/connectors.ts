/**
 * The standard connectors `kv/v1` and `sql/v1`.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-connectors
 */
import * as v from "valibot";
import { connector, event, rpc } from "../connector.ts";

/** A key-value store with string keys and string values. */
export const Kv = connector("kv/v1", {
  get: rpc(v.string(), v.nullable(v.string())),
  set: rpc(v.object({ key: v.string(), value: v.string() }), v.undefined()),
  delete: rpc(v.string(), v.boolean()),
  keys: rpc(v.string(), v.array(v.string())),
  changed: event(v.object({ key: v.string() })),
});

/** A value that `sql/v1` binds as a parameter or returns in a row. */
export const SqlValue = v.union([
  v.string(),
  v.number(),
  v.bigint(),
  v.boolean(),
  v.null(),
  v.instance(Uint8Array),
]);

/** One SQL statement with positional `?` parameters. */
export const SqlStatement = v.object({
  sql: v.string(),
  params: v.optional(v.array(SqlValue)),
});

/** What `run` reports for a statement. */
export const SqlRunResult = v.object({
  changes: v.number(),
  lastInsertRowid: v.union([v.number(), v.bigint()]),
});

/** A SQL database. */
export const Sql = connector("sql/v1", {
  query: rpc(SqlStatement, v.array(v.record(v.string(), SqlValue))),
  run: rpc(SqlStatement, SqlRunResult),
  batch: rpc(v.array(SqlStatement), v.array(SqlRunResult)),
});
