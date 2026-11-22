/**
 * What the window asks the Tauri shell: where the rack listens, and its token.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-windows-protocol
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#net-tool-and-ci
 */
import { invoke } from "@tauri-apps/api/core";
import type { Endpoint } from "./connection.ts";

/**
 * Where the rack listens: from the Tauri shell, which rejects with its message once the rack
 * couldn't start or has stopped, or, in a browser during development, from the page's `?url=`
 * and `&token=`.
 */
export async function endpoint(): Promise<Endpoint> {
  if ("__TAURI_INTERNALS__" in window) return invoke<Endpoint>("endpoint");
  const params = new URLSearchParams(location.search);
  const url = params.get("url");
  const token = params.get("token");
  if (import.meta.env.DEV && url !== null && token !== null) return { url, token };
  throw new Error("no rack to connect to; start the tool with `bun run tauri dev`");
}
