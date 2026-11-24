/**
 * The dashboard's page in a browser, as an operator uses it: headless Chrome opens the URL that
 * `rack dashboard` prints, sees the rack's devices and their states, a crash as it happens, and
 * a restart that it confirms; it keeps a device's details within a phone's screen, and shows
 * nothing of the rack without the URL's fragment. The tests run where a browser is found; in CI,
 * which has one on each system, a missing browser fails them instead.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#operations-from-the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { slot } from "racku";
import {
  Cli,
  CONTROL_DIR,
  FIXTURES,
  type TempApp,
  tempApp,
  useControlDir,
  useRacks,
} from "./fixtures/app.ts";
import { type Browser, browserForTests, launchBrowser, type Page } from "./fixtures/browser.ts";

/** The browser's executable; `undefined` skips the tests, outside CI only. */
const chrome = browserForTests();

const startRack = useRacks();
useControlDir();

// The racks in the test's process use the runtime directory of the dashboards that it starts.
let savedRuntime: string | undefined;
beforeAll(() => {
  savedRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = CONTROL_DIR;
});
afterAll(() => {
  if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedRuntime;
});

const apps: TempApp[] = [];
const processes: Cli[] = [];
const pages: Page[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
  await Promise.all(processes.splice(0).map((cli) => cli.stop()));
  await Promise.all(apps.splice(0).map((app) => app.remove()));
});

/** A rack of two devices: the counter at U1, and a device three U high from U3 up. */
const SPEC = { slots: { 1: slot("./devices/counter.ts"), 3: slot("./devices/tall.ts") } };

/** The line that `rack dashboard` prints first. */
const URL_LINE = /^dashboard of .+ at (http:\/\/127\.0\.0\.1:(\d+)\/#token=[\w-]+)$/m;

/** How long a test may take: it starts a rack, a dashboard, and a tab, and waits on polls. */
const TEST_MS = 60_000;

/** How long the page may take to show a change, which it reads within a second or two. */
const SHOWN_MS = 15_000;

/** Starts a rack in a new app, with its management endpoint, and `rack dashboard` for it. */
async function rackWithDashboard() {
  const app = await tempApp(["connectors.ts", "devices"], FIXTURES);
  apps.push(app);
  const { running } = await startRack(SPEC, {
    baseDir: app.dir,
    control: true,
    faultInjection: true,
  });
  const cli = new Cli(["dashboard", "--dir", app.dir], FIXTURES);
  processes.push(cli);
  const [, url = "", port = ""] = await cli.waitFor(URL_LINE);
  return { running, cli, url, origin: `http://127.0.0.1:${port}` };
}

describe.skipIf(chrome === undefined)("the dashboard's page in a browser", () => {
  let browser: Browser | undefined;
  beforeAll(async () => {
    browser = await launchBrowser(chrome);
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function newPage(): Promise<Page> {
    if (browser === undefined) throw new Error("the browser didn't start");
    const page = await browser.newPage();
    pages.push(page);
    return page;
  }

  // @doc docs/guides/managing.md#the-dashboard
  test(
    "shows the rack's devices, a crash as it happens, and runs a restart once it is confirmed",
    async () => {
      const { running, cli, url } = await rackWithDashboard();
      const page = await newPage();
      await page.navigate(url);

      // The token left the address bar for the tab's session storage.
      expect(
        await page.waitFor(
          "location.hash === '' && sessionStorage.getItem('racku-dashboard-token') !== null",
        ),
      ).toBe(true);

      // Both devices on the rack's front, online, and the page reading the rack.
      await page.waitFor("document.querySelectorAll('button[data-device]').length === 2", SHOWN_MS);
      await page.waitFor(
        "[...document.querySelectorAll('button[data-device]')].every((block) => block.dataset.state === 'online')",
        SHOWN_MS,
      );
      const blocks = await page.evaluate<string[]>(
        "[...document.querySelectorAll('button[data-device]')].map((block) => block.dataset.device)",
      );
      expect(blocks.toSorted()).toEqual(["counter", "tall"]);
      await page.waitFor(
        "document.querySelector('.connection')?.dataset.state === 'live'",
        SHOWN_MS,
      );

      // A crash shows in the events, and in the device's crashes.
      await page.click('button[data-device="counter"]');
      await running.injectFault("counter", "crash");
      await page.waitFor(
        "document.querySelector('.event-list li[data-type=\"fault\"]') !== null",
        SHOWN_MS,
      );
      await page.waitFor(
        "document.querySelector('[data-field=\"crashes\"] dd')?.textContent === '1'",
        SHOWN_MS,
      );
      await page.waitFor(
        "document.querySelector('button[data-device=\"counter\"]')?.dataset.state === 'online'",
        SHOWN_MS,
      );

      // Restart asks first: nothing runs until the dialog is confirmed.
      await page.click('button[data-op="restart"]');
      await page.waitFor("document.querySelector('dialog.confirm-dialog')?.open === true");
      expect(running.history("counter")).toEqual([]);
      await page.click("dialog.confirm-dialog [data-confirm]");
      await page.waitFor("document.querySelector('.op-card')?.dataset.outcome === 'ok'", SHOWN_MS);
      expect(running.history("counter")[0]).toEqual(
        expect.objectContaining({ cause: "restart", mode: "restart", ok: true }),
      );
      await page.waitFor(
        "document.querySelectorAll('.history-panel tr[data-seq]').length > 0",
        SHOWN_MS,
      );
      expect(cli.stdout).toContain("restart counter: ok");

      // No exception, CSP violation, failed request, or console call along the way.
      expect(page.messages).toEqual([]);
    },
    TEST_MS,
  );

  test(
    "keeps a device's details within the screen's width on a phone 320 px wide",
    async () => {
      const { url } = await rackWithDashboard();
      const page = await newPage();
      // A phone's screen, whose browser applies the page's viewport tag.
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 640,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await page.navigate(url);
      await page.click('button[data-device="counter"]', SHOWN_MS);
      // The details with their parts, such as the watchdogs and listeners, and the counters.
      await page.waitFor(
        "document.querySelectorAll('.device-body .parts .part').length > 0 && document.querySelector('.counters table') !== null",
        SHOWN_MS,
      );
      expect(await page.evaluate("document.documentElement.clientWidth")).toBe(320);
      // Nothing in the details is wider than their panel, and nothing makes the page wider than
      // the screen; a wide table scrolls within itself.
      expect(
        await page.evaluate(
          "(() => { const panel = document.querySelector('.details-panel'); return panel.scrollWidth - panel.clientWidth; })()",
        ),
      ).toBe(0);
      expect(await page.evaluate("document.documentElement.scrollWidth")).toBe(320);
      expect(page.messages).toEqual([]);
    },
    TEST_MS,
  );

  // @doc docs/guides/managing.md#the-dashboard
  test(
    "shows nothing of the rack without the URL's fragment, and sends it no request",
    async () => {
      const { origin } = await rackWithDashboard();
      const page = await newPage();
      await page.navigate(`${origin}/`);
      await page.waitFor("document.querySelector('[data-gate=\"no-token\"]') !== null", SHOWN_MS);
      expect(await page.evaluate("document.querySelectorAll('button[data-device]').length")).toBe(
        0,
      );
      expect(
        await page.evaluate(
          "performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/')).length",
        ),
      ).toBe(0);
      expect(page.messages).toEqual([]);
    },
    TEST_MS,
  );
});
