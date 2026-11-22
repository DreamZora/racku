/**
 * What an executable that `rack compile` made carries, and how its code finds the paths it would
 * have on disk: the table of its packaged firmware, the root of its files inside, and the base
 * directory it runs for. The executable sets them once, before its rack starts; a rack outside an
 * executable has none.
 *
 * Each device file has a key, which `rack compile` computes from the file's place and the
 * executable from the path the manifest gives:
 * - a file in the app's directory, outside `node_modules`, has its path from that directory, with
 *   `/`, such as `devices/greeter.ts`; in the executable, that path under the base directory is
 *   where its outside file goes;
 * - any other file, such as one of racku's own devices, has `~/` and that path, with `_up_` for
 *   each `..`; in the executable, it has that path under the executable's root, where no file
 *   is.
 *
 * Packaged code gets its `import.meta` paths from {@link installImportMeta}'s function, by key, so
 * the manifest and the devices name the paths that the executable gives their files.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md
 */
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** What `rack compile` writes into an executable for its rack. */
export interface PackagedTable {
  /** The rack's name. */
  rack: string;
  /** The Worker host's entry: a path from the executable's root, with `/`. */
  worker: string;
  /** Each packaged firmware, by the key of its device file: its path from the root, and hash. */
  devices: Record<string, { file: string; hash: string }>;
  /**
   * The packages that firmware built from outside files imports from the executable: each
   * specifier that the packaged firmware imports, with the path of its module from the root.
   */
  carried: Record<string, string>;
  /** The device files that each directory of a scanned rack held, by key, in scan order. */
  scans: Record<string, string[]>;
  /** The plan file of a scanned rack, by its name, as it was at compile time. */
  plans: Record<string, string>;
}

/** The executable's packaged rack, as it runs. */
export interface Packaged {
  table: PackagedTable;
  /** The absolute path of the executable's root inside, such as `/$bunfs/root`. */
  root: string;
  /** The base directory the executable runs for. */
  baseDir: string;
  /** The `file:` URL of the Worker host inside the executable. */
  workerUrl: string;
}

/** The symbol under which the Worker host of an executable puts the modules that firmware imports. */
export const HOST_MODULES: unique symbol = Symbol.for("racku.hostModules");

/** The symbol of the function that packaged code calls for its `import.meta` paths. */
const IMPORT_META: unique symbol = Symbol.for("racku.importMeta");

/** The symbol of the base directory that the function names app files under, in each thread. */
const BASE_DIR: unique symbol = Symbol.for("racku.baseDir");

const KEY_UP = "_up_";

let current: Packaged | undefined;
let installedRoot: string | undefined;

/**
 * Sets the executable's packaged rack. The executable calls it once, before its rack starts.
 *
 * @param table The table that `rack compile` wrote.
 * @param baseDir The base directory the executable runs for, absolute.
 * @throws Error when {@link installImportMeta} hasn't run in this thread.
 */
export function setPackaged(table: PackagedTable, baseDir: string): Packaged {
  if (installedRoot === undefined) throw new Error("the executable's root is unknown");
  const root = installedRoot;
  setBaseDir(baseDir);
  current = {
    table,
    root,
    baseDir,
    workerUrl: pathToFileURL(join(root, ...table.worker.split("/"))).href,
  };
  return current;
}

/** The executable's packaged rack, or `undefined` outside an executable. */
export function packaged(): Packaged | undefined {
  return current;
}

/**
 * Installs, in this thread, the function that packaged code calls for its `import.meta` paths.
 * The executable's main module and its Worker host call it first, before any packaged module
 * runs.
 *
 * @param inside The absolute path of the executable's root inside.
 */
export function installImportMeta(inside: string): void {
  const root = inside.replace(/(?<=.)[\\/]+$/, "");
  installedRoot = root;
  (globalThis as Record<symbol, unknown>)[IMPORT_META] = (key: string, what: string) => {
    const base = key.startsWith("~/")
      ? root
      : ((globalThis as Record<symbol, unknown>)[BASE_DIR] as string | undefined);
    if (base === undefined) throw new Error(`no base directory for the import.meta of ${key}`);
    const path = join(base, ...key.split("/"));
    if (what === "url") return pathToFileURL(path).href;
    if (what === "dir" || what === "dirname") return dirname(path);
    return path;
  };
}

/** Sets the base directory that the `import.meta` paths of app files are under, in this thread. */
export function setBaseDir(baseDir: string): void {
  (globalThis as Record<symbol, unknown>)[BASE_DIR] = baseDir;
}

/**
 * The expression that packaged code evaluates in place of an `import.meta` path.
 *
 * @param key The key of the file.
 * @param what The path: `url`, `dir`, `dirname`, `path`, or `filename`.
 */
export function importMetaExpression(key: string, what: string): string {
  return `globalThis[Symbol.for("racku.importMeta")](${JSON.stringify(key)}, ${JSON.stringify(what)})`;
}

/**
 * The key of a file, from its place relative to the app's directory.
 *
 * @param path The file's absolute path, its real path at compile time.
 * @param appDir The app's directory: the manifest's at compile time, the base directory after.
 */
export function fileKey(path: string, appDir: string): string {
  const from = relative(appDir, path);
  // On Windows, a file on another drive than the app has no relative path: its key keeps the
  // drive's letter.
  const absolute = isAbsolute(from);
  const parts = (absolute ? from.replaceAll(":", "") : from)
    .split(/[\\/]+/)
    .filter((part) => part !== "");
  if (!absolute && parts[0] !== ".." && !parts.includes("node_modules")) return parts.join("/");
  return ["~", ...parts.map((part) => (part === ".." ? KEY_UP : part))].join("/");
}

/** Whether a key names a file whose outside file may replace its packaged firmware. */
export function hasOutsideFile(key: string): boolean {
  return !key.startsWith("~/");
}

/**
 * The key of a device file as the executable's rack names it: under the executable's root, or
 * under the base directory.
 */
export function keyOfSource(source: string, rack: Packaged): string {
  const inside = relative(rack.root, source);
  if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    return inside.split(sep).join("/");
  }
  return relative(rack.baseDir, source).split(sep).join("/");
}

/** The path that a key gives a device file in the executable. */
export function sourceOfKey(key: string, rack: Packaged): string {
  return join(key.startsWith("~/") ? rack.root : rack.baseDir, ...key.split("/"));
}
