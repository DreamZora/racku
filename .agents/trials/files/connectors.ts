import { connector, rpc, stream } from "racku";
import * as v from "valibot";

export const Info = v.object({ name: v.string(), size: v.number(), sha256: v.string() });

/** The file store: the only writer of the files. */
export const Files = connector("files/v1", {
  put: rpc(v.object({ name: v.string(), bytes: stream() }), Info),
  /** The file's info and its absolute path on disk, or null. */
  stat: rpc(v.string(), v.nullable(v.object({ ...Info.entries, path: v.string() }))),
  list: rpc(v.undefined(), v.array(Info)),
  remove: rpc(v.string(), v.boolean()),
});
