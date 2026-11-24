/**
 * The dashboard's page in a browser, as an operator uses it: headless Chrome opens the URL that
 * `rack dashboard` prints, and sees the rack's devices and their states, and a crash as it
 * happens. The page runs Restart, Swap, Reload, Roll back, and Stop once their dialogs are
 * confirmed, and nothing for a dialog that is cancelled; it keeps a device's details within a
 * phone's screen, and shows nothing of the rack without the URL's fragment. The tests run where a
 * browser is found; in CI, which has one on each system, a missing browser fails them instead.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#operations-from-the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type RackHandle, slot } from "racku";
import { shortHash } from "../src/dashboard/page/format.ts";
import {
  Cli,
  CONTROL_DIR,
  FIXTURES,
  type TempApp,
  tempApp,
  useControlDir,
  useRacks,
  waitFor,
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
  return { app, running, cli, url, origin: `http://127.0.0.1:${port}` };
}

/** The firmware that a device of the rack runs. */
function firmwareOf(running: RackHandle, name: string): string {
  const firmware = running.status().find((device) => device.name === name)?.firmware;
  if (typeof firmware !== "string") throw new Error(`${name} runs no firmware`);
  return firmware;
}

/** Edits the counter's file in the app, which its next build makes new firmware of. */
async function setCounterVersion(app: TempApp, version: string): Promise<void> {
  const path = "devices/counter.ts";
  const source = await app.read(path);
  const edited = source.replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`);
  if (edited === source) throw new Error(`${path} has no VERSION line to edit`);
  await app.write(path, edited);
}

/** The lines in which `rack dashboard` prints the operations it forwarded, with their outcomes. */
function operationLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => /^(reload|swap|restart|rollback|stop)\b/.test(line));
}

/** Waits for the dialog that asks before an operation runs, and returns the text it shows. */
async function dialogText(page: Page): Promise<string> {
  await page.waitFor("document.querySelector('dialog.confirm-dialog')?.open === true");
  return page.evaluate<string>("document.querySelector('dialog.confirm-dialog').innerText");
}

/** Waits for the card of an operation that ended, and returns its outcome and its text. */
function outcomeCard(page: Page, op: string): Promise<{ outcome: string; text: string }> {
  return page.waitFor(
    `(() => {
      const card = document.querySelector('.op-card[data-op="${op}"]');
      return card === null ? null : { outcome: card.dataset.outcome, text: card.innerText };
    })()`,
    SHOWN_MS,
  );
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

  // @doc docs/guides/managing.md#the-dashboard
  test(
    "swaps a device, reloads the rack, and rolls the device back to its known-good firmware, each once confirmed, and Cancel sends nothing",
    async () => {
      const { app, running, cli, url } = await rackWithDashboard();
      const page = await newPage();
      await page.navigate(url);
      // The dialogs name what the dashboard watches, once the page knows it.
      await page.waitFor(
        `document.querySelector('[data-target]')?.textContent === ${JSON.stringify(app.dir)}`,
        SHOWN_MS,
      );
      await page.click('button[data-device="counter"]', SHOWN_MS);
      const first = firmwareOf(running, "counter");
      const source = running.status().find((device) => device.name === "counter")?.source;

      // Swap builds the device's own file again, which the test edits first.
      await setCounterVersion(app, "v2");
      await page.click('.device-head button[data-op="swap"]');
      const swap = await dialogText(page);
      expect(swap).toContain("Swap counter");
      expect(swap).toContain(`from its file, ${source}`);
      // Cancel closes the dialog, and sends nothing.
      await page.click("dialog.confirm-dialog button.cancel");
      await page.waitFor("document.querySelector('dialog.confirm-dialog')?.open === false");
      expect(await page.evaluate("document.querySelector('.op-card') === null")).toBe(true);
      expect(firmwareOf(running, "counter")).toBe(first);
      expect(running.history()).toEqual([]);
      await page.click('.device-head button[data-op="swap"]');
      await dialogText(page);
      await page.click("dialog.confirm-dialog [data-confirm]");
      const swapped = await outcomeCard(page, "swap");
      expect(swapped.outcome).toBe("ok");
      expect(swapped.text).toContain("Swap counter: the new build runs");
      const second = firmwareOf(running, "counter");
      expect(second).not.toBe(first);
      expect(running.history("counter")[0]).toEqual(
        expect.objectContaining({ cause: "swap", from: first, to: second, ok: true }),
      );

      // Reload rebuilds every device's firmware, and replaces the one whose file changed.
      await setCounterVersion(app, "v3");
      await page.click('.rack-ops button[data-op="reload"]');
      const reload = await dialogText(page);
      expect(reload).toContain("Reload the rack");
      expect(reload).toContain(`every device of the rack of ${app.dir}`);
      await page.click("dialog.confirm-dialog [data-confirm]");
      const reloaded = await outcomeCard(page, "reload");
      expect(reloaded.outcome).toBe("ok");
      expect(reloaded.text).toContain("Reload the rack: replaced 1 device");
      expect(reloaded.text).toContain("counter: hot");
      const third = firmwareOf(running, "counter");
      expect([first, second]).not.toContain(third);
      expect(running.history("counter")[0]).toEqual(
        expect.objectContaining({ cause: "reload", from: second, to: third, ok: true }),
      );
      expect(running.history("tall")).toEqual([]);

      // Roll back offers the known-good firmware first: the first one, since the swap and the
      // reload are still on probation. Without `to`, rollback() would go to the second.
      await page.click('.device-head button[data-op="rollback"]');
      const rollback = await dialogText(page);
      expect(rollback).toContain("Roll back counter");
      expect(
        await page.evaluate(
          "document.querySelector('dialog.confirm-dialog .choice-label').textContent",
        ),
      ).toBe(`Its known-good firmware, ${shortHash(first)}`);
      await page.click('dialog.confirm-dialog input[data-choice="0"]');
      await page.click("dialog.confirm-dialog [data-confirm]");
      const rolledBack = await outcomeCard(page, "rollback");
      expect(rolledBack.outcome).toBe("ok");
      expect(firmwareOf(running, "counter")).toBe(first);
      expect(running.history("counter")[0]).toEqual(
        expect.objectContaining({ cause: "rollback", from: third, to: first, ok: true }),
      );

      // The dashboard forwarded these three, with the known-good hash as `to`, and nothing for
      // the dialog that was cancelled.
      expect(operationLines(cli.stdout)).toEqual([
        "swap counter: ok",
        "reload: ok",
        `rollback counter {"to":"${first}"}: ok`,
      ]);
      // The page's history lists the three updates, newest first.
      await page.waitFor(
        "document.querySelectorAll('.history-panel tbody tr[data-seq]').length === 3",
        SHOWN_MS,
      );
      expect(
        await page.evaluate(
          "[...document.querySelectorAll('.history-panel tbody tr[data-seq]')].map((row) => row.children[3].textContent)",
        ),
      ).toEqual(["rollback", "reload", "swap"]);
      expect(page.messages).toEqual([]);
    },
    TEST_MS,
  );

  // @doc docs/guides/managing.md#the-dashboard
  test(
    "stops the rack once confirmed, in a dialog that names its base directory, and then shows that the rack doesn't answer",
    async () => {
      const { app, running, cli, url } = await rackWithDashboard();
      const page = await newPage();
      await page.navigate(url);
      await page.waitFor(
        `document.querySelector('[data-target]')?.textContent === ${JSON.stringify(app.dir)}`,
        SHOWN_MS,
      );
      await page.waitFor(
        "document.querySelector('.connection')?.dataset.state === 'live'",
        SHOWN_MS,
      );

      // Stop's dialog names the base directory, and says what stopping means.
      await page.click('.rack-ops button[data-op="stop"]');
      const stop = await dialogText(page);
      expect(stop).toContain(`Stop the rack of ${app.dir}.`);
      expect(stop).toContain("The rack shuts down");
      expect(stop).toContain("The dashboard can't start it again.");
      // Cancel closes the dialog, and sends nothing: the rack runs on.
      await page.click("dialog.confirm-dialog button.cancel");
      await page.waitFor("document.querySelector('dialog.confirm-dialog')?.open === false");
      expect(await page.evaluate("document.querySelector('.op-card') === null")).toBe(true);
      expect(running.status()).toHaveLength(2);

      await page.click('.rack-ops button[data-op="stop"]');
      await dialogText(page);
      await page.click("dialog.confirm-dialog [data-confirm]");
      const stopped = await outcomeCard(page, "stop");
      expect(stopped.outcome).toBe("ok");
      expect(stopped.text).toContain("The rack is shutting down");
      // The rack stops after its answer, and then reports no device.
      await waitFor(() => running.status().length === 0, SHOWN_MS);
      expect(operationLines(cli.stdout)).toEqual(["stop: ok"]);

      // The page says since when the rack doesn't answer, and why, and dims the last data.
      await page.waitFor(
        "document.querySelector('.connection')?.dataset.state === 'down'",
        SHOWN_MS,
      );
      const banner = await page.evaluate<string>("document.querySelector('.banner').innerText");
      expect(banner).toContain("No answer from the rack since");
      expect(banner).toContain(`no running rack has the base directory ${app.dir}`);
      expect(
        await page.evaluate("document.querySelector('.front-panel').classList.contains('stale')"),
      ).toBe(true);
      await cli.waitFor(/^the rack doesn't answer: /m);
      // Chrome logs each read that the dashboard has answered with 502 since; the page itself
      // reports nothing.
      const failedReads = (message: (typeof page.messages)[number]) =>
        message.kind === "log" &&
        message.source === "network" &&
        message.text.includes("status of 502") &&
        message.url?.includes("/api/v1/") === true;
      expect(page.messages.filter((message) => !failedReads(message))).toEqual([]);
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
