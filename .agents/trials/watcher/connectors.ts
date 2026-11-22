import { connector, rpc } from "racku";
import * as v from "valibot";

/** What one fetch found: a status and a body hash, or an error. */
export const Result = v.object({
  status: v.optional(v.number()),
  hash: v.optional(v.string()),
  error: v.optional(v.string()),
});
export type Result = v.InferOutput<typeof Result>;

export const Report = v.object({
  url: v.string(),
  at: v.string(),
  from: v.nullable(Result),
  to: Result,
});
export type Report = v.InferOutput<typeof Report>;

export const Observation = v.object({ url: v.string(), at: v.string(), result: Result });

/** The checkers send what they find; the store keeps it and decides what changed. */
export const Reports = connector("watcher-reports/v1", {
  observe: rpc(Observation, v.boolean()),
});
