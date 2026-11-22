import { connector, rpc } from "racku";
import * as v from "valibot";

/** Makes codes for new links. */
export const Codes = connector("codes/v1", {
  make: rpc(v.undefined(), v.string()),
});

const Link = v.object({ code: v.string(), url: v.string(), visits: v.number() });

/** Stores links and counts their visits. */
export const Links = connector("links/v1", {
  /** Stores a link; fails with LINK_TAKEN when the code exists. */
  add: rpc(v.object({ code: v.string(), url: v.string() }), v.object({ code: v.string(), url: v.string() })),
  /** A link and its visits, or null. */
  get: rpc(v.string(), v.nullable(Link)),
  /** Counts a visit and gives the link's URL, or null. */
  visit: rpc(v.string(), v.nullable(v.string())),
});
