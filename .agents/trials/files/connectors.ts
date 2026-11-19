import { connector, rpc, stream } from "rack42u";
import * as v from "valibot";

export const Meta = v.object({ name: v.string(), size: v.number(), sha256: v.string() });

/** Where a stored file is, for a reader that sends it itself. */
export const Located = v.object({ path: v.string(), size: v.number(), sha256: v.string() });

export const Files = connector("files/v1", {
  put: rpc(v.object({ name: v.string(), bytes: stream() }), Meta),
  list: rpc(v.undefined(), v.array(Meta)),
  locate: rpc(v.string(), v.nullable(Located)),
  remove: rpc(v.string(), v.boolean()),
});
