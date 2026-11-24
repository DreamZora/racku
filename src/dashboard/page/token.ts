/**
 * The page's token: it comes in the fragment of the URL that `rack dashboard` printed, moves to
 * the tab's session storage, and goes with every request as `Authorization: Bearer <token>`.
 * This module uses no API of the DOM or of Bun; the page hands it the fragment and the storage.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */

/** The key under which the tab's session storage keeps the token. */
export const TOKEN_KEY = "racku-dashboard-token";

/** The part of the `Storage` interface that the page uses, which `sessionStorage` implements. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Reads the token from a URL's fragment, `#token=<token>`, among other `name=value` pairs
 * separated by `&`. It decodes percent escapes, but not `+`, which a token in base64url doesn't
 * hold anyway.
 *
 * @param fragment The fragment with or without its leading `#`, such as `location.hash`.
 * @returns The token, or `null` when the fragment has none, or an empty one, or one whose escapes
 *   don't decode.
 */
export function tokenInFragment(fragment: string): string | null {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  for (const pair of text.split("&")) {
    if (!pair.startsWith("token=")) continue;
    try {
      const token = decodeURIComponent(pair.slice("token=".length));
      return token === "" ? null : token;
    } catch {
      // A malformed escape: no usable token in this pair.
      return null;
    }
  }
  return null;
}

/** What {@link takeToken} found. */
export interface TakenToken {
  /** The token to send, or `null` when the page has none. */
  token: string | null;
  /** Whether the fragment held a token, which the page then takes out of the address bar. */
  fromFragment: boolean;
}

/**
 * Takes the page's token: from the fragment when it holds one, which also replaces the one in
 * storage, so that the URL of a dashboard started again wins over the token of its earlier start;
 * or else from storage.
 *
 * A storage that throws, such as one that the browser disabled, leaves the token in the page's
 * memory only.
 *
 * @param fragment The URL's fragment, such as `location.hash`.
 * @param storage The tab's session storage.
 * @returns The token, and whether it came from the fragment.
 */
export function takeToken(fragment: string, storage: TokenStorage): TakenToken {
  const given = tokenInFragment(fragment);
  if (given !== null) {
    try {
      storage.setItem(TOKEN_KEY, given);
    } catch {
      // Without storage the token lasts until the tab reloads; the page still works.
    }
    return { token: given, fromFragment: true };
  }
  try {
    const kept = storage.getItem(TOKEN_KEY);
    return { token: kept === null || kept === "" ? null : kept, fromFragment: false };
  } catch {
    // A storage that can't be read holds no token for the page.
    return { token: null, fromFragment: false };
  }
}

/**
 * Forgets the stored token, as the page does when the dashboard refuses it with 401: it belongs
 * to an earlier start of the dashboard, and only the URL that the dashboard printed helps.
 *
 * @param storage The tab's session storage.
 */
export function forgetToken(storage: TokenStorage): void {
  try {
    storage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to forget in a storage that can't be used.
  }
}

/**
 * The value of the `Authorization` header that carries the token.
 *
 * @param token The token.
 * @returns `Bearer <token>`.
 */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}
