/**
 * Holds the reference under docs/reference/ to the code, in both directions: every export, error
 * code, command, flag, and log entry it lists exists, and everything of those kinds that the code
 * has is listed.
 *
 * @decision .agents/decisions/261119_055008-documentation.md#tests-that-hold-the-documentation
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT } from "./fixtures/app.ts";

const read = (path: string) => Bun.file(join(ROOT, path)).text();

/** The source files under `src/`, as text. */
async function sources(): Promise<string[]> {
  const paths = [...new Bun.Glob("**/*.ts").scanSync(join(ROOT, "src"))].sort();
  return Promise.all(paths.map((path) => read(join("src", path))));
}

/** The rows of the tables in `markdown` whose header is `header`, each as its cells. */
function rows(markdown: string, header: string): string[][] {
  const result: string[][] = [];
  let inside = false;
  for (const line of markdown.split("\n")) {
    if (line === header) inside = true;
    else if (!line.startsWith("|")) inside = false;
    else if (inside && !line.startsWith("|---")) {
      result.push(
        line
          .slice(1, -1)
          .split(" | ")
          .map((cell) => cell.trim()),
      );
    }
  }
  return result;
}

/** The names that a cell lists in code spans, such as `` `--url <url>`, `--token-file <file>` ``. */
function names(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? "").split(/[ (]/)[0] ?? "");
}

/** The text of each code span in a cell. */
function spans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** The names an entry point exports, types included. */
function exportsOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const item of (match[1] ?? "").split(",")) {
      const name = item.trim().replace(/^type\s+/, "");
      if (name !== "") found.push(name);
    }
  }
  const declaration =
    /^export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(declaration)) found.push(match[1] ?? "");
  return found.sort();
}

// @doc docs/reference/api.md#racku
// @doc docs/reference/api.md#connectors
// @doc docs/reference/api.md#devices
// @doc docs/reference/api.md#errors
// @doc docs/reference/api.md#listeners
// @doc docs/reference/api.md#manifests
// @doc docs/reference/api.md#start
// @doc docs/reference/api.md#the-rack-handle
// @doc docs/reference/api.md#metrics
// @doc docs/reference/api.md#logs
// @doc docs/reference/api.md#schemas
// @doc docs/reference/api.md#rackustd
// @doc docs/reference/api.md#standard-connectors
// @doc docs/reference/api.md#standard-devices
// @doc docs/reference/api.md#http-handlers
// @doc docs/reference/api.md#rackubench
// @doc docs/reference/api.md#the-bench
// @doc docs/reference/api.md#device-files-of-the-bench
test("the API reference lists every export of the three entry points, and nothing else", async () => {
  const api = await read("docs/reference/api.md");
  const entries = {
    racku: "src/index.ts",
    "racku/std": "src/std/index.ts",
    "racku/bench": "src/bench.ts",
  };
  for (const [entry, file] of Object.entries(entries)) {
    const start = api.indexOf(`\n## ${entry}\n`);
    expect(start).toBeGreaterThan(-1);
    const end = api.indexOf("\n## ", start + 1);
    const part = api.slice(start, end === -1 ? undefined : end);
    const listed = rows(part, "| Export | Kind | What it is |").flatMap(([name = ""]) =>
      names(name),
    );
    expect({ entry, listed: listed.sort() }).toEqual({
      entry,
      listed: exportsOf(await read(file)),
    });
  }
  const kinds = ["function", "class", "constant", "type"];
  const unknown = rows(api, "| Export | Kind | What it is |").filter(
    ([, kind = ""]) => !kinds.includes(kind),
  );
  expect(unknown).toEqual([]);
});

// @doc docs/reference/api.md#start
// @doc docs/reference/limits.md#timeouts
// @doc docs/reference/limits.md#queues-and-backlogs
// @doc docs/reference/limits.md#supervision-and-history
test("the defaults of start() in the reference are the ones the code has", async () => {
  const source = await read("src/rack.ts");
  const from = source.indexOf("constructor(manifest: RackManifest, options: StartOptions)");
  const body = source.slice(from, source.indexOf("\n  }\n", from));
  const defaults: Record<string, number> = {};
  for (const [, name = "", value = ""] of body.matchAll(/options\.(\w+) \?\? ([\d_]+)\b/g)) {
    defaults[name] = Number(value.replaceAll("_", ""));
  }
  expect(body).toContain("options.queueLimit ?? QUEUE_LIMIT");
  const limit =
    /export const QUEUE_LIMIT = ([\d_]+);/.exec(await read("src/protocol.ts"))?.[1] ?? "";
  defaults.queueLimit = Number(limit.replaceAll("_", ""));

  const api = await read("docs/reference/api.md");
  const listed: Record<string, number> = {};
  for (const [option = "", value = ""] of rows(api, "| `start` option | Default | Meaning |")) {
    const number = /^(\d[\d ]*)(?: ms)?$/.exec(value)?.[1];
    if (number !== undefined) listed[names(option)[0] ?? ""] = Number(number.replaceAll(" ", ""));
  }
  expect(listed).toEqual(defaults);
  expect(Object.keys(listed).sort()).toEqual([
    "callTimeout",
    "drainTimeout",
    "historyLimit",
    "hookTimeout",
    "probation",
    "queueLimit",
    "watchdog",
  ]);
});

// @doc docs/reference/limits.md#supervision-and-history
// @doc docs/reference/limits.md#the-dashboard
// @doc docs/reference/limits.md#rack-ctl
// @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
test("the bounds of the feed, the dashboard, and its page in the reference are the ones the code has", async () => {
  const dashboard = await import("../src/dashboard/server.ts");
  const { FEED_LIMIT: PAGE_RECORDS } = await import("../src/dashboard/page/feed.ts");
  const { READINGS_PER_DEVICE } = await import("../src/dashboard/page/rates.ts");
  const { POLL_INTERVALS } = await import("../src/dashboard/page/poller.ts");
  const rack = await read("src/rack.ts");
  const constant = (name: string) =>
    Number(new RegExp(`const ${name} = ([\\d_]+);`).exec(rack)?.[1]?.replaceAll("_", ""));
  /** A number as the reference writes it, with a space between each group of three digits. */
  const spaced = (value: number) => String(value).replace(/\B(?=(\d{3})+$)/g, " ");

  const limits = await read("docs/reference/limits.md");
  const bounds = new Map(
    rows(limits, "| Bound | Value | Beyond it |").map(([bound = "", value = ""]) => [bound, value]),
  );
  const value = (bound: string) => bounds.get(bound) ?? `no row "${bound}"`;
  expect(value("Records of the feed of recent events, which `events()` reads")).toBe(
    spaced(constant("FEED_LIMIT")),
  );
  expect(value("One record of the feed, as JSON")).toBe(
    `${spaced(constant("RECORD_MAX"))} characters`,
  );
  expect(limits).toContain(`its messages are cut to ${spaced(constant("CUT_MESSAGE"))} characters`);
  expect(value("Requests of `rack dashboard` that wait for the rack")).toBe(
    String(dashboard.WAITING_LIMIT),
  );
  expect(value("A request's body")).toBe(`${dashboard.BODY_LIMIT / 1024} KiB`);
  expect(value("A read's wait for the rack")).toStartWith(`${dashboard.READ_TIMEOUT_MS / 1000} s,`);
  expect(value("An operation's wait for the rack")).toBe(
    `${dashboard.OPERATION_TIMEOUT_MS / 60_000} minutes`,
  );
  expect(value("A read's wait of `rack ctl`: `status`, `metrics`, `history`, and `events`")).toBe(
    `${dashboard.READ_TIMEOUT_MS / 1000} s`,
  );
  expect(
    value("An operation's wait of `rack ctl`: `reload`, `swap`, `restart`, `rollback`, and `stop`"),
  ).toBe(`${dashboard.OPERATION_TIMEOUT_MS / 60_000} minutes`);
  expect(value("Records of the feed that the page keeps")).toBe(spaced(PAGE_RECORDS));
  expect(value("Readings of the counters that the page keeps per device, for its charts")).toBe(
    String(READINGS_PER_DEVICE),
  );
  expect(POLL_INTERVALS).toEqual({ status: 1_000, history: 1_000, events: 1_000, metrics: 2_000 });
  expect(limits).toContain(
    "The page asks for the rack's state, its history, and its events every second, and for its counters every 2 seconds",
  );
});

// @doc docs/reference/api.md#the-rack-handle
test("the rack handle's table lists every method of RackHandle, with the type it returns", async () => {
  const source = await read("src/rack.ts");
  const from = source.indexOf("export interface RackHandle {");
  const body = source.slice(from, source.indexOf("\n}\n", from));
  const methods: Record<string, string> = {};
  for (const [, name = "", returns = ""] of body.matchAll(/^ {2}(\w+)\(.*\): (.+);$/gm)) {
    methods[name] = returns;
  }
  expect(Object.keys(methods)).toHaveLength(14);

  const api = await read("docs/reference/api.md");
  const listed: Record<string, string> = {};
  for (const [method = "", returns = ""] of rows(api, "| Method | Returns | Purpose |")) {
    for (const name of names(method)) listed[name] = spans(returns).join(" ");
  }
  expect(listed).toEqual(methods);
});

// @doc docs/reference/errors.md#codes
// @doc docs/reference/errors.md#codes-of-the-standard-devices
test("the error codes reference lists every code that the rack and the standard devices raise", async () => {
  const errors = await read("docs/reference/errors.md");
  const code = (await sources()).join("\n");
  const rack = [...new Set(code.match(/"RACK_[A-Z_]+"/g) ?? [])].map((c) => c.slice(1, -1)).sort();
  const listed = rows(errors, "| Code | Meaning |").flatMap(([cell = ""]) => names(cell));
  expect(listed.sort()).toEqual(rack);
  const std =
    (
      await Promise.all(
        [...new Bun.Glob("*.ts").scanSync(join(ROOT, "src", "std"))].map((path) =>
          read(join("src", "std", path)),
        ),
      )
    )
      .join("\n")
      .match(/RackError\(\s*"([A-Z_]+)"/g)
      ?.map((c) => /"([A-Z_]+)"/.exec(c)?.[1] ?? "")
      .filter((c) => !c.startsWith("RACK_")) ?? [];
  const listedStd = rows(errors, "| Code | Device | Meaning |").flatMap(([cell = ""]) =>
    names(cell),
  );
  expect(listedStd.sort()).toEqual([...new Set(std)].sort());
});

// @doc docs/reference/cli.md#commands
// @doc docs/reference/cli.md#flags-of-rack-start-and-rack-dev
// @doc docs/reference/cli.md#flags-of-rack-plan
// @doc docs/reference/cli.md#operations-of-rack-ctl
// @doc docs/reference/cli.md#flags-of-rack-ctl
// @doc docs/reference/cli.md#flags-of-rack-compile
// @doc docs/reference/cli.md#flags-of-rack-dashboard
// @doc docs/reference/cli.md#the-command-line-of-an-executable
test("the reference of the rack command lists every command, flag, and operation", async () => {
  const cli = await read("docs/reference/cli.md");
  const source = await read("src/cli.ts");
  const flagsOf = (command: string) =>
    (new RegExp(`^ {2}${command}: \\[([^\\]]*)\\]`, "m").exec(source)?.[1] ?? "")
      .split(",")
      .map((flag) => flag.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .sort();
  const section = (title: string) => {
    const start = cli.indexOf(`\n## ${title}\n`);
    expect(start).toBeGreaterThan(-1);
    const end = cli.indexOf("\n## ", start + 1);
    return cli.slice(start, end === -1 ? undefined : end);
  };
  const listedFlags = (title: string) =>
    [
      ...new Set(rows(section(title), "| Flag | Meaning |").flatMap(([cell = ""]) => names(cell))),
    ].sort();

  const commands = rows(section("Commands"), "| Command | Does |").map(
    ([cell = ""]) => /`rack (\w+)/.exec(cell)?.[1] ?? "",
  );
  expect(commands.sort()).toEqual(["compile", "ctl", "dashboard", "dev", "plan", "start"]);
  expect(flagsOf("start")).toEqual(flagsOf("dev"));
  expect(listedFlags("Flags of rack start and rack dev")).toEqual(flagsOf("start"));
  expect(listedFlags("Flags of rack plan")).toEqual(flagsOf("plan"));
  expect(listedFlags("Flags of rack compile")).toEqual(flagsOf("compile"));
  expect(listedFlags("Flags of rack ctl")).toEqual(flagsOf("ctl"));
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#documentation
  expect(listedFlags("Flags of rack dashboard")).toEqual(flagsOf("dashboard"));

  // An executable takes the flags of rack start with two of its own, --base-dir and --watch, and
  // those of rack ctl and rack dashboard with --base-dir for --dir.
  // @decision .agents/decisions/261120_221450-watching-outside-files.md#on-command-or-as-files-change
  // @decision .agents/decisions/261124_055114-rack-dashboard.md#rack-dashboard
  const executable = await read("src/executable.ts");
  const listOf = (name: string) =>
    (new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(executable)?.[1] ?? "")
      .split(",")
      .map((flag) => flag.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .sort();
  expect(listedFlags("The command line of an executable")).toEqual(["--base-dir", "--watch"]);
  expect(listOf("START_FLAGS")).toEqual([...flagsOf("start"), "--base-dir", "--watch"].sort());
  expect(listOf("CTL_FLAGS")).toEqual(
    flagsOf("ctl")
      .map((flag) => (flag === "--dir" ? "--base-dir" : flag))
      .sort(),
  );
  expect(listOf("DASHBOARD_FLAGS")).toEqual(
    flagsOf("dashboard")
      .map((flag) => (flag === "--dir" ? "--base-dir" : flag))
      .sort(),
  );

  // The operations of rack ctl, which an executable's ctl shares, are in commands.ts.
  const shared = await read("src/commands.ts");
  const body = shared.slice(
    shared.indexOf("function ctlArgs"),
    shared.indexOf("default:", shared.indexOf("function ctlArgs")),
  );
  const operations = [...body.matchAll(/case "(\w+)":/g)].map((match) => match[1] ?? "").sort();
  const listedOperations = rows(section("Operations of rack ctl"), "| Operation | Runs |").map(
    ([cell = ""]) => /`rack ctl (\w+)/.exec(cell)?.[1] ?? "",
  );
  expect(listedOperations.sort()).toEqual(operations);
});

// @doc docs/reference/reports.md#the-log
test("every log entry that the reports reference lists is one that the rack writes", async () => {
  const reports = await read("docs/reference/reports.md");
  // A message with its variable parts as `<>`: `<device> swapped` in the reference, and
  // `${slot.name} swapped` in the code, both become `<> swapped`.
  const skeleton = (message: string) =>
    message.replace(/<[^>]+>|\$\{[^}]+\}/g, "<>").replace(/(<>)+/g, "<>");
  const code = (await sources()).join("\n");
  const written = new Set(
    [...code.matchAll(/(?:"(?:debug|info|warn|error)",\s*|message: )(`[^`]*`|"[^"]*")/g)].map(
      (match) => skeleton((match[1] ?? "").slice(1, -1)),
    ),
  );
  const listed = rows(reports, "| Message | Level | When | `data` |").flatMap(([cell = ""]) =>
    spans(cell),
  );
  expect(listed.length).toBeGreaterThan(10);
  expect(listed.filter((message) => !written.has(skeleton(message)))).toEqual([]);
});
