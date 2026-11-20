import { connector, rpc } from "rack42u";
import * as v from "valibot";

/** What one fetch of a URL gave: a status code or an error, and a hash of the body. */
export const Result = v.object({
  status: v.optional(v.number()),
  error: v.optional(v.string()),
  hash: v.optional(v.string()),
});
export type Result = v.InferOutput<typeof Result>;

const Record = v.object({
  url: v.string(),
  at: v.number(),
  result: Result,
  /** Set when the result differs from the previous one. */
  from: v.optional(Result),
});

/** What the checkers tell the store, and what they ask it. */
export const Watch = connector("watcher/v1", {
  record: rpc(Record, v.undefined()),
  last: rpc(v.string(), v.nullable(Result)),
  forget: rpc(v.string(), v.undefined()),
});
