/**
 * The dashboard's page: it takes its token from the URL's fragment, reads the rack through the
 * dashboard every second, and shows it.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */
import { Client } from "./api.ts";
import { Model, startPolling } from "./model.ts";
import { Operations } from "./operations.ts";
import { Page, showGate } from "./page.ts";
import type { Scheduler } from "./poller.ts";
import { forgetToken, type TokenStorage, takeToken } from "./token.ts";

const app = document.getElementById("app");
// A page in another site's frame shows nothing, and reads no token.
// @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
if (app !== null && window.top === window.self) start(app);

/** The tab's session storage, or a storage of the page's memory when the browser refuses it. */
function sessionStore(): TokenStorage {
  try {
    const storage = window.sessionStorage;
    if (storage !== null && storage !== undefined) return storage;
  } catch {
    // A browser that blocks storage throws here; the token then lasts until the tab reloads.
  }
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** Takes the fragment out of the address bar, so that no bookmark, screenshot, or link holds it. */
function dropFragment(): void {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function start(root: HTMLElement): void {
  const storage = sessionStore();
  const taken = takeToken(location.hash, storage);
  if (taken.fromFragment) dropFragment();
  // A URL that the operator opens in this tab, such as that of a dashboard started again, only
  // changes the fragment, which reloads nothing: the page takes its token, and starts again.
  window.addEventListener("hashchange", () => {
    if (!takeToken(location.hash, storage).fromFragment) return;
    dropFragment();
    location.reload();
  });
  if (taken.token === null) {
    showGate(root, "no-token");
    return;
  }
  const client = new Client({ token: taken.token, fetch: (url, init) => fetch(url, init) });
  const model = new Model();
  const operations = new Operations((op, args, waitMs) => client.call(op, args, waitMs), Date.now);
  const page = new Page(root, model, operations, Date.now);
  let drawing = false;
  let forgotten = false;
  const draw = () => {
    if (drawing) return;
    drawing = true;
    requestAnimationFrame(() => {
      drawing = false;
      if (model.final?.status === 401 && !forgotten) {
        // The token is from an earlier start of the dashboard: only its new URL helps.
        forgotten = true;
        forgetToken(storage);
      }
      page.render();
    });
  };
  const scheduler: Scheduler = {
    every: (ms, tick) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
  };
  startPolling(model, (op, args) => client.call(op, args), scheduler, Date.now, draw);
  // The ages that the page shows grow each second, also while no answer comes.
  setInterval(draw, 1_000);
  window.addEventListener("resize", draw);
  page.render();
}
