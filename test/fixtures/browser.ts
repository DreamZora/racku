/**
 * A driver of headless Chrome or Chromium for tests that check a page in a browser, such as the
 * dashboard's. It speaks the DevTools protocol over Bun's WebSocket, so it needs no dependency:
 * {@link findBrowser} finds the browser, {@link browserForTests} decides whether a test runs or
 * skips, and {@link launchBrowser} starts the browser with a profile of its own. Each
 * {@link Page} navigates, evaluates expressions in its document or in a frame of it, waits for
 * them, clicks as a user does, and collects what the page reports outside its DOM, so that a test
 * can assert that there is none.
 *
 * Every wait is bounded: the launch by {@link LAUNCH_MS}; a command's answer, a page's load,
 * `waitFor`, and `click` by {@link TIMEOUT_MS} unless the call names its own bound; and each step
 * of `close()` by a few seconds. A browser that a test leaves open ends with the test's process.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
 */
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BROWSERS } from "../../scripts/render-images.ts";

/**
 * How long {@link launchBrowser} waits for the browser to announce its DevTools endpoint on its
 * standard error and to accept a connection there, in ms.
 */
export const LAUNCH_MS = 15_000;

/**
 * The bound, in ms, on a command's answer, a page's load, `waitFor`, and `click`, when the call
 * doesn't name its own.
 */
export const TIMEOUT_MS = 10_000;

/** How long `close()` waits for the browser to exit once asked, and again once killed, in ms. */
const CLOSE_MS = 5_000;

/**
 * How long `close()` goes on removing the profile, in ms: Windows keeps the files that the
 * browser's processes hold until they have ended.
 */
const REMOVE_MS = 10_000;

/** How often `waitFor` and `click` look again, in ms. */
const POLL_MS = 50;

/** The most messages that a page keeps; it only counts the ones after them. */
const MESSAGES_MAX = 1_000;

/** The most characters of a message's text, or of a value or an expression in an error. */
const TEXT_MAX = 2_000;

/** The most characters of the browser's standard error that are kept, for the errors of a launch. */
const STDERR_MAX = 16_384;

/** The name of the worlds in which `evaluateInFrame` evaluates, apart from the frames' scripts. */
const WORLD_NAME = "racku-test";

/** Where Google Chrome and Chromium install on macOS. */
const MAC_INSTALLS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/**
 * Something that a page reported outside its DOM. A page that runs without a fault reports
 * none, so a test can expect its {@link Page.messages} to equal `[]`.
 */
export interface PageMessage {
  /**
   * What reported it:
   * - `console`: a call of the console API, such as `console.error`;
   * - `exception`: an exception that nothing caught, or a rejection that nothing handled;
   * - `log`: an entry of the browser's own log, such as a CSP violation, whose `source` is
   *   `security`, or a request that failed or got an HTTP error, whose `source` is `network`;
   * - `dialog`: an alert, confirm, prompt, or beforeunload dialog, which the page answered as
   *   {@link Page.acceptDialogs} says.
   */
  kind: "console" | "exception" | "log" | "dialog";
  /**
   * For `console`, the method's type, such as `log`, `info`, `warning`, or `error`; for `log`,
   * the entry's level, `verbose`, `info`, `warning`, or `error`; `error` for an exception; and
   * `info` for a dialog.
   */
  level: string;
  /** For `log`, where the entry came from, such as `security` or `network`; for `dialog`, its type. */
  source?: string;
  /** The message: the console call's arguments, the exception with its stack, or the dialog's text. */
  text: string;
  /** The URL of the script or document it came from, when the browser names one. */
  url?: string;
}

/** A frame of a tab's document, as {@link Page.frames} lists it. */
export interface Frame {
  /** The browser's id of the frame, which {@link Page.evaluateInFrame} takes. */
  id: string;
  /** The id of the frame that holds it; absent for the top one. */
  parentId?: string;
  /** The URL of its document, without the fragment. */
  url: string;
}

/**
 * A tab of the browser, in a window of its own, attached over the DevTools protocol. It collects
 * {@link messages} from its creation on.
 */
export interface Page {
  /**
   * The first 1,000 things the page reported outside its DOM, oldest first: console calls,
   * uncaught exceptions, the browser's log entries, such as CSP violations, and dialogs. A text
   * longer than 2,000 characters is cut, ending in `…`.
   */
  readonly messages: readonly PageMessage[];
  /** How many messages came after the page kept its first 1,000, which it only counts. */
  readonly droppedMessages: number;
  /**
   * Whether the page's native dialogs, `alert()`, `confirm()`, `prompt()`, and `beforeunload`,
   * are accepted; by default they are dismissed, so that none blocks the page's script. Either
   * way, each is in {@link messages}.
   */
  acceptDialogs: boolean;

  /**
   * Navigates the tab to `url`, and waits until its document has loaded, its `load` event
   * included. A navigation within the same document, such as to another fragment, loads nothing,
   * and resolves at once.
   *
   * @param timeoutMs The bound on the navigation and the load; {@link TIMEOUT_MS} by default.
   * @throws Error when the navigation fails, such as on a refused connection, naming the
   *   browser's reason, or when the document hasn't loaded within the bound.
   */
  navigate(url: string, timeoutMs?: number): Promise<void>;

  /**
   * Evaluates a JavaScript expression in the page's document, waits for the promise it returns,
   * and returns its value as JSON carries it: `NaN`, the infinities, `-0`, and a `bigint` come
   * back as themselves, `undefined` as `undefined`, and a DOM node as `{}`.
   *
   * @param expression An expression, such as `document.title`; a test file has no DOM types, so
   *   the page's code goes in as text.
   * @param timeoutMs The bound on the answer; {@link TIMEOUT_MS} by default.
   * @throws Error when the expression throws, or its promise rejects, with the exception and its
   *   stack; when the browser doesn't answer within the bound; or when the page or the browser
   *   has closed.
   */
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;

  /**
   * Lists the frames of the tab's document, as the browser has them: the top one first, and each
   * frame before the frames below it. A frame from another site, which the browser runs in a
   * process of its own, isn't listed.
   *
   * @param timeoutMs The bound on the answer; {@link TIMEOUT_MS} by default.
   * @throws Error when the browser doesn't answer within the bound, or when the page or the
   *   browser has closed.
   */
  frames(timeoutMs?: number): Promise<Frame[]>;

  /**
   * Evaluates a JavaScript expression in a frame of the tab's document, as {@link evaluate} does
   * in the top one, but in a world of the driver's own: it shares the frame's DOM, storage, and
   * performance timeline, and none of the globals of the frame's scripts, so that it reads the
   * frame the same whatever those scripts did.
   *
   * @param frameId The frame's id, as {@link frames} lists it.
   * @param expression An expression, such as `document.title`.
   * @param timeoutMs The bound on each of the two commands that it sends, which make the world and
   *   evaluate in it; {@link TIMEOUT_MS} by default.
   * @throws Error as {@link evaluate} does, and when the tab has no frame with the id.
   */
  evaluateInFrame<T = unknown>(frameId: string, expression: string, timeoutMs?: number): Promise<T>;

  /**
   * Evaluates `expression` every 50 ms until its value is truthy, and returns that value. An
   * evaluation that throws counts as a falsy one, so that `document.querySelector("#x").textContent`
   * can wait for `#x` to appear.
   *
   * @param timeoutMs How long it waits; {@link TIMEOUT_MS} by default.
   * @throws Error when the value isn't truthy within the bound, naming the last value or the last
   *   exception; at once for an expression with a syntax error, such as an invalid selector, and
   *   when the page or the browser has closed.
   */
  waitFor<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;

  /**
   * Clicks the first element that matches `selector` as a user does: it scrolls the element into
   * view and sends a left click of the mouse to its center, which reaches whatever is on top
   * there. It first waits until the element exists, has a size, isn't hidden or disabled, and
   * nothing else covers its center, such as an overlay or the backdrop of a modal dialog.
   *
   * @param timeoutMs How long it waits for such an element; {@link TIMEOUT_MS} by default.
   * @throws Error when no element is ready within the bound, saying what kept the last one from
   *   it; at once for an invalid selector, and when the page or the browser has closed.
   */
  click(selector: string, timeoutMs?: number): Promise<void>;

  /**
   * Sends any command of the DevTools protocol to the page's session, for what the other methods
   * don't do, such as `Emulation.setEmulatedMedia`.
   *
   * @param timeoutMs The bound on the answer; {@link TIMEOUT_MS} by default.
   * @returns The command's result.
   * @throws Error with the browser's message when the command fails, when the browser doesn't
   *   answer within the bound, or when the page or the browser has closed.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;

  /**
   * Closes the tab. Its methods then fail. Safe to call more than once, and after the browser
   * has closed.
   */
  close(): Promise<void>;
}

/** A browser that {@link launchBrowser} started. */
export interface Browser {
  /** The executable that runs it. */
  readonly executable: string;

  /**
   * Opens a new tab at `about:blank`, in a window of its own, so that it is visible and its
   * timers run at full speed while other tabs are open, and has a session storage of its own.
   *
   * @throws Error when the browser doesn't open or attach the tab within {@link TIMEOUT_MS}, or
   *   has closed.
   */
  newPage(): Promise<Page>;

  /**
   * Closes the browser and removes its profile. It asks the browser to close, kills it with its
   * helpers when it hasn't exited within 5 s, and waits up to 5 s more for the helpers, which
   * write to the profile until they have ended. Commands that wait for an answer, and later ones,
   * fail at once. Safe to call more than once: every call returns the first call's promise. Call
   * it when the test is done, such as in `afterAll`; a browser left open ends with the test's
   * process.
   *
   * @throws Error when the profile can't be removed within 10 s, naming its directory.
   */
  close(): Promise<void>;
}

/**
 * The paths where Chrome installs on this system, which {@link findBrowser} looks at after
 * `PATH`: on macOS, Google Chrome's and Chromium's in `/Applications`; on Windows, Chrome's under
 * `%ProgramFiles%`, `%ProgramFiles(x86)%`, and `%LOCALAPPDATA%`; on other systems, none.
 */
function installs(): string[] {
  if (process.platform === "darwin") return MAC_INSTALLS;
  if (process.platform !== "win32") return [];
  const bases = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
  ];
  // An unset variable names no install, and a relative one would point into the working
  // directory.
  const paths = bases
    .filter((base): base is string => base !== undefined && isAbsolute(base))
    .map((base) => join(base, "Google", "Chrome", "Application", "chrome.exe"));
  return [...new Set(paths)];
}

/** The places that {@link findBrowser} looks at, in its order, for a note or an error. */
function places(): string {
  return ["CHROME", `PATH (${BROWSERS.join(", ")})`, ...installs()].join(", ");
}

/**
 * Finds the Chrome or Chromium that tests drive, in this order:
 * - `CHROME`, the path of a browser's executable, as given;
 * - the first of the names that `bun run render:images` looks for, `google-chrome`,
 *   `google-chrome-stable`, `chromium`, and `chromium-browser`, on `PATH`;
 * - where Chrome installs: on macOS, `/Applications/Google Chrome.app` and
 *   `/Applications/Chromium.app`; on Windows, `Google\Chrome\Application\chrome.exe` under
 *   `%ProgramFiles%`, `%ProgramFiles(x86)%`, and `%LOCALAPPDATA%`.
 *
 * @returns The executable's path, or `undefined` when none of these has one.
 */
export function findBrowser(): string | undefined {
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
  const chrome = process.env.CHROME;
  if (chrome !== undefined && chrome !== "") return chrome;
  for (const name of BROWSERS) {
    const path = Bun.which(name);
    if (path !== null) return path;
  }
  return installs().find((path) => existsSync(path));
}

/** Whether {@link browserForTests} has printed its note. */
let noted = false;

/**
 * The browser for a test that drives one: {@link findBrowser}'s, or `undefined` when there is
 * none and the test is to skip. Call it at the top level of a test file, and pass the outcome to
 * `test.skipIf` or `describe.skipIf`:
 *
 * ```ts
 * const chrome = browserForTests();
 * describe.skipIf(chrome === undefined)("the page in a browser", () => {...});
 * ```
 *
 * Without a browser, it prints a note once per process that names the places it looked at.
 *
 * @returns The executable's path, or `undefined` without a browser outside CI.
 * @throws Error when no browser is found and `CI` is set, naming the places it looked at: CI's
 *   systems have Chrome, so a test that needs one fails there instead of skipping.
 */
export function browserForTests(): string | undefined {
  const found = findBrowser();
  if (found !== undefined) return found;
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#tests
  const ci = process.env.CI;
  if (ci !== undefined && ci !== "") {
    throw new Error(`no Chrome or Chromium found, and CI is set: looked at ${places()}`);
  }
  if (!noted) {
    noted = true;
    console.warn(
      `note: no Chrome or Chromium found, so the tests that drive one are skipped; looked at ${places()}. Set CHROME to a browser's path to run them.`,
    );
  }
  return undefined;
}

/**
 * Starts the browser headless, with a new profile in a temporary directory, and connects to its
 * DevTools endpoint. The browser keeps its sandbox, except where it says that it can't have one,
 * such as for root on Linux: it then exits at once naming `--no-sandbox`, and starts once more
 * with it.
 *
 * @param executable The browser's executable; by default {@link findBrowser}'s.
 * @returns The running browser. Call its `close()` when done.
 * @throws Error when no browser is found, naming the places looked at; or when the browser can't
 *   start, exits, or hasn't announced its endpoint and accepted the connection within
 *   {@link LAUNCH_MS}, with the end of its standard error. Nothing of a failed launch is left
 *   running, and its profile is removed.
 */
export async function launchBrowser(executable = findBrowser()): Promise<Browser> {
  if (executable === undefined) {
    throw new Error(`no Chrome or Chromium found: looked at ${places()}`);
  }
  try {
    return await start(executable, true);
  } catch (error) {
    if (!(error instanceof SandboxUnavailable)) throw error;
    return await start(executable, false);
  }
}

/** A browser that exited at once, saying that it can't run with its sandbox here. */
class SandboxUnavailable extends Error {}

/** The browser's command line after its executable. */
function flagsFor(profile: string, sandbox: boolean): string[] {
  return [
    "--headless=new",
    // A free port, which the browser announces on its standard error.
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    // A new profile would otherwise ask the keychain of macOS, or a keyring of a Linux desktop,
    // for the key of its stored secrets, which can stop the browser at a prompt.
    "--use-mock-keychain",
    "--password-store=basic",
    ...(sandbox ? [] : ["--no-sandbox"]),
    "about:blank",
  ];
}

/**
 * One attempt to start the browser.
 *
 * @throws SandboxUnavailable when the browser, with its sandbox, exits at once naming
 *   `--no-sandbox`.
 */
async function start(executable: string, sandbox: boolean): Promise<ChromeBrowser> {
  const deadline = Date.now() + LAUNCH_MS;
  const profile = await mkdtemp(join(tmpdir(), "racku-browser-"));
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    child = Bun.spawn([executable, ...flagsFor(profile, sandbox)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (error) {
    const removed = await removeProfile(profile).then(
      () => "",
      (e) => `; ${messageOf(e)}`,
    );
    throw new Error(`the browser ${executable} didn't start: ${messageOf(error)}${removed}`);
  }
  const stderr = new Stderr(child.stderr);
  let failure: string;
  try {
    const outcome = await within(
      Promise.race([
        stderr.announced.then((url) => ({ url })),
        child.exited.then((code) => ({ code })),
      ]),
      deadline - Date.now(),
    );
    if (outcome === undefined) {
      failure = `didn't announce its DevTools endpoint within ${LAUNCH_MS} ms`;
    } else if ("url" in outcome) {
      const connection = await Connection.open(outcome.url, deadline - Date.now());
      return new ChromeBrowser(executable, child, stderr, connection, profile);
    } else {
      // What it wrote before it exited may still be in the pipe.
      await within(stderr.ended, CLOSE_MS);
      if (sandbox && stderr.tail.includes("--no-sandbox")) {
        await removeProfile(profile);
        throw new SandboxUnavailable();
      }
      failure = `exited with code ${outcome.code} before it announced its DevTools endpoint`;
    }
  } catch (error) {
    if (error instanceof SandboxUnavailable) throw error;
    failure = messageOf(error);
  }
  killTree(child);
  await ended(child, stderr);
  const removed = await removeProfile(profile).then(
    () => "",
    (e) => `; ${messageOf(e)}`,
  );
  const output = stderr.tail.trim();
  throw new Error(
    `the browser ${executable} ${failure}${removed}${output === "" ? "" : `; its standard error ends with:\n${output.slice(-TEXT_MAX)}`}`,
  );
}

/**
 * The browser's standard error, read to its end, so that the browser never stops on a full pipe,
 * with its last {@link STDERR_MAX} characters kept.
 */
class Stderr {
  /** The last characters read. */
  tail = "";
  /** Resolves with the URL of the DevTools endpoint, once the browser has announced it. */
  readonly announced: Promise<string>;
  /**
   * Resolves when the stream has ended: once the browser and the helpers that inherited the
   * stream from it, its renderers among them, have exited.
   */
  readonly ended: Promise<true>;
  #announce: (url: string) => void = () => {};
  #found = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.announced = new Promise((resolve) => {
      this.#announce = resolve;
    });
    this.ended = this.#read(stream);
  }

  async #read(stream: ReadableStream<Uint8Array>): Promise<true> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.tail = (this.tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_MAX);
        const match = this.#found ? null : /DevTools listening on (ws:\/\/\S+)/.exec(this.tail);
        if (match !== null) {
          this.#found = true;
          this.#announce(match[1] as string);
        }
      }
    } catch {
      // The pipe broke as the browser ended; what was read is kept.
    }
    return true;
  }
}

/** The browsers that haven't closed yet, which the exit of the test's process ends. */
const live = new Set<ChromeBrowser>();

/** Whether the handler of the process's exit is in place. */
let exitHandled = false;

/** A browser started by {@link launchBrowser}. */
class ChromeBrowser implements Browser {
  readonly executable: string;
  readonly #child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  readonly #stderr: Stderr;
  readonly #connection: Connection;
  readonly #profile: string;
  #closed: Promise<void> | undefined;

  constructor(
    executable: string,
    child: Bun.Subprocess<"ignore", "ignore", "pipe">,
    stderr: Stderr,
    connection: Connection,
    profile: string,
  ) {
    this.executable = executable;
    this.#child = child;
    this.#stderr = stderr;
    this.#connection = connection;
    this.#profile = profile;
    void child.exited.then((code) => {
      connection.end(`the browser exited with ${child.signalCode ?? `code ${code}`}`);
    });
    live.add(this);
    if (!exitHandled) {
      exitHandled = true;
      // A test that fails before it closes its browser would leave it running after the test's
      // process has exited, with its profile.
      process.on("exit", () => {
        for (const browser of live) browser.killNow();
      });
    }
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.#connection.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const { sessionId } = await this.#connection.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    const page = new ChromePage(this.#connection, targetId, sessionId);
    await page.enable();
    return page;
  }

  close(): Promise<void> {
    this.#closed ??= this.#close();
    return this.#closed;
  }

  async #close(): Promise<void> {
    // The browser may end the connection before it answers, so the answer isn't awaited.
    this.#connection.send("Browser.close", {}, undefined, CLOSE_MS).catch(() => {
      // Its exit, or the kill below, tells the outcome.
    });
    // What waits for the browser, and what comes later, fails at once, saying why.
    this.#connection.end("the browser closed");
    if ((await within(this.#child.exited, CLOSE_MS)) === undefined) killTree(this.#child);
    await ended(this.#child, this.#stderr);
    live.delete(this);
    this.#connection.close();
    await removeProfile(this.#profile);
  }

  /**
   * Ends the browser and its helpers at once, as the test's process exits, and removes its
   * profile, trying again for a moment while a helper that was ending writes to it.
   */
  killNow(): void {
    killTree(this.#child);
    for (let tries = 1; ; tries++) {
      try {
        rmSync(this.#profile, { recursive: true, force: true });
        return;
      } catch (error) {
        if (tries === 10) {
          console.warn(`the browser's profile ${this.#profile} stays: ${messageOf(error)}`);
          return;
        }
        Bun.sleepSync(20);
      }
    }
  }
}

/**
 * Waits up to {@link CLOSE_MS} for the browser to exit, and as long again for its helpers, which
 * write to its profile until they have ended.
 */
async function ended(child: Bun.Subprocess, stderr: Stderr): Promise<void> {
  await within(child.exited, CLOSE_MS);
  await within(stderr.ended, CLOSE_MS);
}

/**
 * Kills the browser and its helpers, such as its renderers, at once: a helper that outlived the
 * browser would go on writing to the profile. On Windows, `taskkill /T` ends the tree; elsewhere,
 * the processes below the browser, as `ps` lists them before the browser ends, get `SIGKILL`
 * after it.
 */
function killTree(child: Bun.Subprocess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: CLOSE_MS,
    });
    child.kill("SIGKILL");
    return;
  }
  // Once the browser has ended, its helpers belong to another parent, and can't be found.
  const helpers = descendants(child.pid);
  child.kill("SIGKILL");
  for (const pid of helpers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has exited since `ps` listed it.
    }
  }
}

/**
 * The processes below `pid`, from the table that `ps` lists; none where `ps` fails, since the
 * browser's helpers end soon after the browser.
 */
function descendants(pid: number): number[] {
  let table: string;
  try {
    const listed = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: CLOSE_MS,
    });
    if (listed.exitCode !== 0) return [];
    table = listed.stdout.toString();
  } catch {
    // No `ps` on this system.
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined || child === parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = new Set<number>();
  const next = [pid];
  for (let parent = next.pop(); parent !== undefined; parent = next.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (found.has(child) || child === pid) continue;
      found.add(child);
      next.push(child);
    }
  }
  return [...found];
}

/**
 * Removes a profile, and tries again for {@link REMOVE_MS} while it fails, since Windows keeps
 * the files of processes that are still ending.
 *
 * @throws Error naming the profile when it is still there after that.
 */
async function removeProfile(profile: string): Promise<void> {
  const until = Date.now() + REMOVE_MS;
  for (;;) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= until) {
        throw new Error(
          `the browser's profile ${profile} couldn't be removed within ${REMOVE_MS} ms: ${messageOf(error)}`,
        );
      }
      await Bun.sleep(100);
    }
  }
}

/** A message from the browser: an answer carries its command's `id`, an event its `method`. */
interface Message {
  id?: number;
  result?: unknown;
  error?: { message: string; data?: string };
  method?: string;
  params?: Record<string, unknown>;
  /** The session of a page that the answer or event belongs to; absent for the browser's own. */
  sessionId?: string;
}

/** A command that waits for its answer. */
interface Pending {
  method: string;
  sessionId: string | undefined;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The WebSocket connection to the browser's DevTools endpoint, which carries the sessions of its
 * pages too, in the protocol's flat mode.
 */
class Connection {
  readonly #ws: WebSocket;
  #lastId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(message: Message) => void>();
  #ended: string | undefined;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#receive(event.data));
    ws.addEventListener("close", () => this.end("the browser closed the DevTools connection"));
  }

  /**
   * Connects to the endpoint.
   *
   * @throws Error when the connection fails or isn't open within `ms`.
   */
  static open(url: string, ms: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(
        () => {
          ws.close();
          reject(new Error(`didn't accept a DevTools connection within ${LAUNCH_MS} ms`));
        },
        Math.max(0, ms),
      );
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new Connection(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`refused the DevTools connection to ${url}`));
        },
        { once: true },
      );
    });
  }

  /** Why the connection ended, or `undefined` while it is open. */
  get ended(): string | undefined {
    return this.#ended;
  }

  /**
   * Sends a command, to a page's session or else to the browser, and waits for its answer.
   *
   * @throws Error with the browser's message when the command fails; when no answer comes within
   *   `timeoutMs`; when the connection has ended; or when the page's session ends first.
   */
  send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    if (this.#ended !== undefined) {
      return Promise.reject(new Error(`${method} failed: ${this.#ended}`));
    }
    const id = ++this.#lastId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        sessionId,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      try {
        this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        this.#fail((pending) => pending.timer === timer, messageOf(error));
      }
    });
  }

  /**
   * Calls `listener` with each event, of the browser and of every page's session.
   *
   * @returns A function that stops the calls.
   */
  listen(listener: (message: Message) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Fails every command that waits, and every later one, with `reason`. */
  end(reason: string): void {
    if (this.#ended !== undefined) return;
    this.#ended = reason;
    this.#fail(() => true, reason);
  }

  /** Ends the connection and closes its WebSocket. */
  close(): void {
    this.end("the browser closed");
    this.#ws.close();
  }

  /** Fails the commands that wait and that `which` picks, with `reason`. */
  #fail(which: (pending: Pending) => boolean, reason: string): void {
    for (const [id, pending] of this.#pending) {
      if (!which(pending)) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method} failed: ${reason}`));
    }
  }

  #receive(data: unknown): void {
    let message: Message;
    try {
      message = JSON.parse(String(data)) as Message;
    } catch {
      // The protocol sends only JSON; anything else carries nothing to act on.
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      // An answer that comes after its command's wait has ended has no one to go to.
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error === undefined) {
        pending.resolve(message.result ?? {});
      } else {
        const data = message.error.data === undefined ? "" : ` (${message.error.data})`;
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}${data}`));
      }
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const session = message.params?.sessionId;
      this.#fail((pending) => pending.sessionId === session, "the page's session ended");
    }
    for (const listener of this.#listeners) listener(message);
  }
}

/** A value in the page, as the protocol describes it. */
interface RemoteObject {
  type: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

/** An exception in the page, as the protocol describes it. */
interface ExceptionDetails {
  text: string;
  url?: string;
  exception?: RemoteObject;
  stackTrace?: { callFrames: { url: string }[] };
}

/** The frames of a page's document, as the protocol describes them. */
interface FrameTree {
  frame: { id: string; parentId?: string; url: string };
  childFrames?: FrameTree[];
}

/** An evaluation in the page that threw. */
class EvaluationError extends Error {
  /** Whether the exception is a `SyntaxError`, such as for an invalid selector, which no retry fixes. */
  readonly syntax: boolean;

  constructor(message: string, syntax: boolean) {
    super(message);
    this.syntax = syntax;
  }
}

/** A point in the page's viewport, in CSS pixels. */
interface Point {
  x: number;
  y: number;
}

/** A tab of the browser, attached in flat mode. */
class ChromePage implements Page {
  readonly messages: PageMessage[] = [];
  droppedMessages = 0;
  acceptDialogs = false;
  readonly #connection: Connection;
  readonly #targetId: string;
  readonly #sessionId: string;
  readonly #unlisten: () => void;
  /** Why the page can't be used any more, or `undefined` while it can. */
  #gone: string | undefined;
  #closed: Promise<void> | undefined;

  constructor(connection: Connection, targetId: string, sessionId: string) {
    this.#connection = connection;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
    this.#unlisten = connection.listen((message) => {
      if (message.method === undefined) return;
      if (message.sessionId === sessionId) {
        this.#event(message.method, message.params ?? {});
      } else if (
        message.method === "Target.detachedFromTarget" &&
        message.params?.sessionId === sessionId
      ) {
        this.#gone ??= "the page's session ended";
      }
    });
  }

  /** Turns on the events that the page collects and waits for. */
  async enable(): Promise<void> {
    await Promise.all([
      this.send("Page.enable"),
      this.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      this.send("Runtime.enable"),
      this.send("Log.enable"),
    ]);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    if (this.#gone !== undefined)
      return Promise.reject(new Error(`${method} failed: ${this.#gone}`));
    return this.#connection.send<T>(method, params, this.#sessionId, timeoutMs);
  }

  async navigate(url: string, timeoutMs = TIMEOUT_MS): Promise<void> {
    const until = Date.now() + timeoutMs;
    // The loads that happen while the navigation goes on, by their loader, since the load of the
    // new document can come before the answer that names its loader.
    const loaded = new Set<string>();
    let wake = () => {};
    const unlisten = this.#connection.listen((message) => {
      if (message.sessionId !== this.#sessionId || message.method !== "Page.lifecycleEvent") return;
      const params = message.params as { name: string; loaderId: string };
      if (params.name !== "load") return;
      loaded.add(params.loaderId);
      wake();
    });
    try {
      const answer = await this.send<{ loaderId?: string; errorText?: string }>(
        "Page.navigate",
        { url },
        timeoutMs,
      );
      if (answer.errorText !== undefined && answer.errorText !== "") {
        throw new Error(`navigate(${url}) failed: ${answer.errorText}`);
      }
      const loader = answer.loaderId;
      // A navigation within the same document has no loader of its own, and loads nothing.
      if (loader === undefined) return;
      const done = await within(
        new Promise<true>((resolve) => {
          wake = () => {
            if (loaded.has(loader)) resolve(true);
          };
          wake();
        }),
        until - Date.now(),
      );
      if (done === undefined) {
        throw new Error(`navigate(${url}) timed out after ${timeoutMs} ms: the page didn't load`);
      }
    } finally {
      unlisten();
    }
  }

  evaluate<T = unknown>(expression: string, timeoutMs = TIMEOUT_MS): Promise<T> {
    return this.#evaluate<T>(expression, timeoutMs);
  }

  async frames(timeoutMs = TIMEOUT_MS): Promise<Frame[]> {
    const { frameTree } = await this.send<{ frameTree: FrameTree }>(
      "Page.getFrameTree",
      {},
      timeoutMs,
    );
    const frames: Frame[] = [];
    const visit = (tree: FrameTree) => {
      const { id, parentId, url } = tree.frame;
      frames.push(parentId === undefined ? { id, url } : { id, parentId, url });
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(frameTree);
    return frames;
  }

  async evaluateInFrame<T = unknown>(
    frameId: string,
    expression: string,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    // A new world for each call: the browser ends a frame's worlds when the frame navigates.
    const { executionContextId } = await this.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId, worldName: WORLD_NAME },
      timeoutMs,
    );
    return this.#evaluate<T>(expression, timeoutMs, executionContextId);
  }

  /**
   * Evaluates `expression` in the top document's own world, or in the context that `contextId`
   * names, and returns its value as {@link evaluate} describes.
   */
  async #evaluate<T>(expression: string, timeoutMs: number, contextId?: number): Promise<T> {
    const answer = await this.send<{ result: RemoteObject; exceptionDetails?: ExceptionDetails }>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId === undefined ? {} : { contextId }),
      },
      timeoutMs,
    );
    const details = answer.exceptionDetails;
    if (details !== undefined) {
      const exception = describeException(details);
      throw new EvaluationError(
        `${shorten(expression, 200)} threw ${shorten(exception)}`,
        /^SyntaxError\b/.test(exception),
      );
    }
    return returnedValue(answer.result) as T;
  }

  waitFor<T = unknown>(expression: string, timeoutMs = TIMEOUT_MS): Promise<T> {
    return this.#poll<T>(expression, timeoutMs, "waitFor", (value) =>
      value ? { done: value as T } : { not: `${shorten(expression, 200)} was ${show(value)}` },
    );
  }

  async click(selector: string, timeoutMs = TIMEOUT_MS): Promise<void> {
    const point = await this.#poll<Point>(
      clickPoint(selector),
      timeoutMs,
      `click(${selector})`,
      (found) =>
        typeof found === "object" && found !== null
          ? { done: found as Point }
          : { not: String(found) },
    );
    const { x, y } = point;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  close(): Promise<void> {
    this.#closed ??= this.#close();
    return this.#closed;
  }

  async #close(): Promise<void> {
    this.#gone ??= "the page closed";
    await this.#connection.send("Target.closeTarget", { targetId: this.#targetId }).catch(() => {
      // The browser has closed, and the page with it.
    });
    this.#unlisten();
  }

  /**
   * Evaluates `expression` until `accept` takes its value, every {@link POLL_MS}, for up to
   * `timeoutMs`. An evaluation that throws counts as one that `accept` doesn't take, unless no
   * retry can change it.
   *
   * @param what What waits, for the error.
   * @param accept `{ done }` with the outcome, or `{ not }` with what kept the value from it.
   */
  async #poll<T>(
    expression: string,
    timeoutMs: number,
    what: string,
    accept: (value: unknown) => { done: T } | { not: string },
  ): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      let last: string;
      try {
        const outcome = accept(
          await this.evaluate(expression, Math.max(until - Date.now(), POLL_MS)),
        );
        if ("done" in outcome) return outcome.done;
        last = outcome.not;
      } catch (error) {
        if (error instanceof EvaluationError ? error.syntax : this.#unusable()) throw error;
        last = messageOf(error);
      }
      const left = until - Date.now();
      if (left <= 0) throw new Error(`${what} timed out after ${timeoutMs} ms: ${last}`);
      await Bun.sleep(Math.min(POLL_MS, left));
    }
  }

  /** Whether the page, or the browser, has gone, so that no command can reach it. */
  #unusable(): boolean {
    return this.#gone !== undefined || this.#connection.ended !== undefined;
  }

  /** Collects what the page reports, and answers its dialogs. */
  #event(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const call = params as {
          type: string;
          args: RemoteObject[];
          stackTrace?: { callFrames: { url: string }[] };
        };
        this.#record({
          kind: "console",
          level: call.type,
          text: call.args.map(describeValue).join(" "),
          url: call.stackTrace?.callFrames[0]?.url,
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const details = (params as { exceptionDetails: ExceptionDetails }).exceptionDetails;
        this.#record({
          kind: "exception",
          level: "error",
          text: describeException(details),
          url: details.url ?? details.stackTrace?.callFrames[0]?.url,
        });
        break;
      }
      case "Log.entryAdded": {
        const { entry } = params as {
          entry: { source: string; level: string; text: string; url?: string };
        };
        this.#record({
          kind: "log",
          level: entry.level,
          source: entry.source,
          text: entry.text,
          url: entry.url,
        });
        break;
      }
      case "Page.javascriptDialogOpening": {
        const dialog = params as { type: string; message: string; url?: string };
        this.#record({
          kind: "dialog",
          level: "info",
          source: dialog.type,
          text: dialog.message,
          url: dialog.url,
        });
        // A dialog stops the page's script until it is answered.
        this.send("Page.handleJavaScriptDialog", { accept: this.acceptDialogs }).catch(() => {
          // The page closed with its dialog open, which answers it.
        });
        break;
      }
    }
  }

  /** Keeps a message, without the fields it lacks, while fewer than {@link MESSAGES_MAX} are kept. */
  #record(message: PageMessage): void {
    if (this.messages.length >= MESSAGES_MAX) {
      this.droppedMessages++;
      return;
    }
    const kept: PageMessage = {
      kind: message.kind,
      level: message.level,
      text: shorten(message.text),
    };
    if (message.source !== undefined) kept.source = message.source;
    if (message.url !== undefined && message.url !== "") kept.url = message.url;
    this.messages.push(kept);
  }
}

/**
 * The expression that finds where `click` clicks the element that `selector` matches: its center
 * once scrolled into view, as `{ x, y }`, or a text that says what keeps it from a click. An
 * invalid selector throws a `SyntaxError`.
 */
function clickPoint(selector: string): string {
  return `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (element === null) return "no element matches it";
  if (element.matches(":disabled")) return "its element is disabled";
  element.scrollIntoView({ block: "center", inline: "center" });
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return "its element has no size, so it isn't shown";
  if (getComputedStyle(element).visibility !== "visible") return "its element is hidden";
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const top = document.elementFromPoint(x, y);
  if (top === null) return "its element's center is outside the window";
  if (top !== element && !element.contains(top)) {
    return "its element is covered by " + top.outerHTML.slice(0, 200);
  }
  return { x, y };
})()`;
}

/** An exception as text: its description, which holds its stack, or else its value or text. */
function describeException(details: ExceptionDetails): string {
  const exception = details.exception;
  if (exception === undefined) return details.text;
  return exception.description ?? describeValue(exception);
}

/** A value of the page as text, as the console shows it. */
function describeValue(object: RemoteObject): string {
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.value !== undefined) {
    return typeof object.value === "string" ? object.value : show(object.value);
  }
  return object.description ?? object.type;
}

/** A value that an evaluation returned by value. */
function returnedValue(object: RemoteObject): unknown {
  const unserializable = object.unserializableValue;
  if (unserializable === undefined) return object.value;
  // `NaN`, `Infinity`, `-Infinity`, `-0`, or a bigint such as `12n`.
  return unserializable.endsWith("n")
    ? BigInt(unserializable.slice(0, -1))
    : Number(unserializable);
}

/** A value as JSON, shortened, for an error. */
function show(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return shorten(JSON.stringify(value) ?? String(value));
  } catch {
    // A bigint, which JSON can't hold.
    return shorten(String(value));
  }
}

/** `text`, cut to `max` characters, the last of them `…`. */
function shorten(text: string, max = TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** An error's message, or what was thrown as text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `promise`'s value, or `undefined` when it hasn't settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
