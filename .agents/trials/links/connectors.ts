import { connector, rpc } from "rack42u";
import * as v from "valibot";

export const Link = v.object({ code: v.string(), url: v.string(), visits: v.number() });

/** Where links and their visits are kept. */
export const Store = connector("links-store/v1", {
  /** Stores a link; false when the code is taken. */
  create: rpc(v.object({ code: v.string(), url: v.string() }), v.boolean()),
  get: rpc(v.string(), v.nullable(Link)),
  /** Counts a visit and returns the link's URL, or null for an unknown code. */
  visit: rpc(v.string(), v.nullable(v.string())),
});

/** Makes the codes of new links. */
export const Codes = connector("link-codes/v1", {
  make: rpc(v.undefined(), v.string()),
});
