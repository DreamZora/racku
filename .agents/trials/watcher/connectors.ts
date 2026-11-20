import { connector, rpc } from "rack42u";
import * as v from "valibot";

/** What one fetch of a URL came to: a status code or an error, and a hash of the body. */
export const Result = v.object({
  status: v.nullable(v.number()),
  error: v.nullable(v.string()),
  hash: v.nullable(v.string()),
});
export type Result = v.InferOutput<typeof Result>;

/** One check of a URL, with the change from its last result, if it changed. */
export const Observation = v.object({
  url: v.string(),
  at: v.string(),
  result: Result,
  change: v.nullable(v.object({ from: Result, to: Result })),
});
export type Observation = v.InferOutput<typeof Observation>;

/** The store that the checkers send their reports to. */
export const Reports = connector("watcher-reports/v1", {
  record: rpc(Observation, v.undefined()),
  last: rpc(v.string(), v.nullable(Result)),
});
