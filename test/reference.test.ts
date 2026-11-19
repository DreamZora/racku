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

/** The names that a cell lists in code spans, such as `` `--url <url>`, `--token <token>` ``. */
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

// @doc docs/reference/api.md#rack42u
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
// @doc docs/reference/api.md#rack42ustd
// @doc docs/reference/api.md#standard-connectors
// @doc docs/reference/api.md#standard-devices
// @doc docs/reference/api.md#http-handlers
// @doc docs/reference/api.md#rack42ubench
// @doc docs/reference/api.md#the-bench
// @doc docs/reference/api.md#device-files-of-the-bench
test("the API reference lists every export of the three entry points, and nothing else", async () => {
  const api = await read("docs/reference/api.md");
  const entries = {
    rack42u: "src/index.ts",
    "rack42u/std": "src/std/index.ts",
    "rack42u/bench": "src/bench.ts",
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
  expect(commands.sort()).toEqual(["ctl", "dev", "plan", "start"]);
  expect(flagsOf("start")).toEqual(flagsOf("dev"));
  expect(listedFlags("Flags of rack start and rack dev")).toEqual(flagsOf("start"));
  expect(listedFlags("Flags of rack plan")).toEqual(flagsOf("plan"));
  expect(listedFlags("Flags of rack ctl")).toEqual(flagsOf("ctl"));

  const body = source.slice(
    source.indexOf("function ctlArgs"),
    source.indexOf("default:", source.indexOf("function ctlArgs")),
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
