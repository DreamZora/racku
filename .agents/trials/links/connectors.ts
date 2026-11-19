import { connector, rpc } from "rack42u";
import * as v from "valibot";

/** Makes codes. */
export const Codes = connector("links.codes/v1", {
  make: rpc(v.undefined(), v.string()),
});

const Link = v.object({ code: v.string(), url: v.string(), visits: v.number() });

/** Stores links and their visits. `add` fails with the code CODE_TAKEN when the code exists. */
export const Links = connector("links.store/v1", {
  add: rpc(v.object({ code: v.string(), url: v.string() }), v.undefined()),
  get: rpc(v.string(), v.nullable(Link)),
  /** Counts a visit and returns the link's URL, or null for an unknown code. */
  visit: rpc(v.string(), v.nullable(v.string())),
});
