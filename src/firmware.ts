/**
 * Firmware builds: each device file becomes one hashed bundle, and the hash is its version. The
 * Worker host loads a bundle with {@link importFirmware}.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 * @decision .agents/decisions/261112_035943-hot-swap.md#firmware
 * @decision .agents/decisions/261119_213017-firmware-import-meta.md
 * @decision .agents/decisions/261120_011627-single-executables.md
 */
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileKey, importMetaExpression } from "./packaged.ts";

/** A built firmware bundle. */
export interface Firmware {
  /** Absolute path of the bundle. */
  path: string;
  /** `file:` URL of the bundle, for `import()` in the Worker. */
  url: string;
  /** Firmware version: the content hash in the bundle's file name. */
  hash: string;
  /** Absolute path of the device file it was built from. */
  source: string;
  /**
   * Every file that the build wrote, the bundle first, such as the files that the device
   * imports with `type: "file"`; absent on firmware packaged inside an executable.
   */
  files?: string[];
  /** Set on firmware packaged inside an executable, which no file on disk holds. */
  packaged?: true;
}

/**
 * How a build for an executable differs from one under `rack start`: racku comes from the
 * Worker host, every other import is bundled, and `import.meta` paths are the executable's.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md#compiling-a-rack
 */
export interface PackagedBuild {
  /** The app's directory, from which the files' keys are worked out; see `packaged.ts`. */
  appDir: string;
  /** Where the bundle goes; by default `.rack/firmware/` under the base directory. */
  outdir?: string;
  /** At run time: the packages that the executable carries, and the executable's root. */
  carried?: { root: string; specifiers: Readonly<Record<string, string>> };
  /** At compile time: the packages that the app declares, and the set of those imported. */
  record?: { declared: ReadonlySet<string>; found: Set<string> };
}

/** The `import.meta` paths that a bundle would otherwise give its own location. */
const IMPORT_META = /\bimport\.meta\.(url|dirname|dir|filename|path)\b/g;
const LOADERS: Record<string, Bun.Loader> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx" };

/**
 * Gives each file of a bundle the `import.meta` paths of its own source: `url`, `path`,
 * `filename`, `dir`, and `dirname`. It rewrites those member accesses in the text, so the words
 * `import.meta.url` in a string or a comment change too, and `import.meta` used whole, such as
 * when destructured, keeps the bundle's.
 *
 * @decision .agents/decisions/261119_213017-firmware-import-meta.md#decision
 */
const SOURCE_IMPORT_META: Bun.BunPlugin = {
  name: "racku-source-import-meta",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      const dir = dirname(path);
      const values: Record<string, string> = {
        url: pathToFileURL(path).href,
        path,
        filename: path,
        dir,
        dirname: dir,
      };
      const text = await Bun.file(path).text();
      const extension = /\.[cm]?([jt]sx?)$/.exec(path)?.[1] ?? "ts";
      return {
        contents: text.replace(IMPORT_META, (_match, key: string) => JSON.stringify(values[key])),
        loader: LOADERS[extension] ?? "ts",
      };
    });
  },
};

/**
 * Gives the files of a build for an executable the `import.meta` paths that the executable gives
 * them when it runs: each file's are worked out from its key, so a file in the app reads what
 * lies under the base directory, at the place of its outside file.
 *
 * @param appDir The app's directory, which the keys are relative to.
 * @param skip Files to leave as they are, such as the entries that `rack compile` generates.
 * @decision .agents/decisions/261120_011627-single-executables.md#running-an-executable
 */
export function packagedImportMeta(
  appDir: string,
  skip: (path: string) => boolean = () => false,
): Bun.BunPlugin {
  return {
    name: "racku-packaged-import-meta",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        const text = await Bun.file(path).text();
        const extension = /\.[cm]?([jt]sx?)$/.exec(path)?.[1] ?? "ts";
        const loader = LOADERS[extension] ?? "ts";
        if (skip(path)) return { contents: text, loader };
        const key = fileKey(path, appDir);
        return {
          contents: text.replace(IMPORT_META, (_match, what: string) =>
            importMetaExpression(key, what),
          ),
          loader,
        };
      });
    },
  };
}

/** The names that firmware imports racku by, which the Worker host gives it in an executable. */
const HOST_SPECIFIER = /^racku(\/std)?$/;

/**
 * Gives firmware in an executable the Worker host's own racku: `racku` and `racku/std`
 * resolve to a module that re-exports what the host put under `HOST_MODULES`, so the firmware
 * and the host share one copy, and the host knows the firmware's `RackError`s.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md#compiling-a-rack
 */
const HOST_RACKU: Bun.BunPlugin = {
  name: "racku-host",
  setup(build) {
    build.onResolve({ filter: HOST_SPECIFIER }, ({ path }) => ({
      path,
      namespace: "racku-host",
    }));
    build.onLoad({ filter: /.*/, namespace: "racku-host" }, async ({ path }) => {
      // Loaded when the build runs, not with this module: both import it.
      const exports =
        path === "racku" ? await import("./index.ts") : await import("./std/index.ts");
      const names = Object.keys(exports).filter((name) => name !== "default");
      const lines = names.map((name) => `export const ${name} = host.${name};`);
      return {
        contents: `const host = globalThis[Symbol.for("racku.hostModules")][${JSON.stringify(path)}];\n${lines.join("\n")}\n`,
        loader: "js",
      };
    });
  },
};

/** The name of the package that a bare specifier imports, such as `@scope/name` or `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

/**
 * Collects, at compile time, the specifiers of the packages that the app declares and the
 * firmware imports, which the executable then carries for firmware built from outside files.
 */
function recordPackages(record: NonNullable<PackagedBuild["record"]>): Bun.BunPlugin {
  return {
    name: "racku-record-packages",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
        if (record.declared.has(packageOf(path))) record.found.add(path);
        return undefined;
      });
    },
  };
}

/**
 * Leaves the packages that the executable carries to the executable, at their path inside it,
 * where firmware built from an outside file imports them.
 */
function carriedPackages(carried: NonNullable<PackagedBuild["carried"]>): Bun.BunPlugin {
  return {
    name: "racku-carried-packages",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
        const inside = carried.specifiers[specifier];
        if (inside === undefined) return undefined;
        const path = join(carried.root, ...inside.split("/")).replaceAll("\\", "/");
        return { path, external: true };
      });
    },
  };
}

/**
 * Lets a package that an executable doesn't carry, which an outside file imports, resolve only to
 * a file inside the base directory, so that no `node_modules` of a parent directory, such as
 * `C:\\node_modules`, which any user on Windows can create, gives an outside file its code.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
function insideBaseDir(baseDir: string): Bun.BunPlugin {
  // Bun resolves to real paths, as /private/var/... for /var/... on macOS.
  const real = (() => {
    try {
      return realpathSync(baseDir);
    } catch {
      // A base directory that doesn't resolve has no files inside to resolve to.
      return baseDir;
    }
  })();
  return {
    name: "racku-inside-base-dir",
    setup(build) {
      build.onResolve({ filter: /^[^./\\]/ }, ({ path: specifier, importer }) => {
        // Built-in modules, and absolute paths on Windows, come from no package.
        if (/^(node|bun):/.test(specifier) || isAbsolute(specifier)) return undefined;
        let found: string;
        try {
          found = Bun.resolveSync(specifier, dirname(importer));
        } catch {
          // The build reports a package that doesn't resolve, as it reports any other.
          return undefined;
        }
        if (!isAbsolute(found) || within(found, baseDir) || within(found, real)) return undefined;
        throw new Error(
          `${specifier} resolves to ${found}, outside the base directory ${baseDir}, and the executable doesn't carry it`,
        );
      });
    },
  };
}

/** Whether `path` is `dir` or lies inside it. */
function within(path: string, dir: string): boolean {
  const rest = relative(dir, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Builds the firmware of one device file into `<baseDir>/.rack/firmware/`.
 *
 * The framework and every dependency declared in the `package.json` closest to the device file
 * stay external, so they resolve through the app's `node_modules`; everything else, including
 * files reached through tsconfig path aliases, is bundled and therefore hot-reloadable.
 *
 * Each file of the bundle keeps the `import.meta` paths of its own source, so a device reads a
 * file next to its source as it would unbundled.
 *
 * For an executable, `packaged` changes three things: racku comes from the Worker host, every
 * other import is bundled, apart from the packages that the executable carries, and the
 * `import.meta` paths are the ones the executable gives the files. A package that an outside
 * file imports, which the executable doesn't carry, must resolve inside the base directory.
 *
 * Builds run with macros turned off, so that no device code runs in the rack's process. A build
 * reads the `tsconfig.json` and the `package.json` closest to the device file, but none above the
 * app's directory. It writes into a directory beside `.rack/firmware/`, at the same depth, so that
 * the bundle's inline source map names the same sources, and moves each file into
 * `.rack/firmware/` unless a file of its name is there: its name holds its content's hash, and a
 * Worker may be reading it.
 *
 * @param source Absolute path of the device file.
 * @param baseDir Rack base directory; firmware must live inside the app directory.
 * @param packaged For an executable: firmware that `rack compile` packages, or that an executable
 *   builds from an outside file.
 * @returns The bundle and its hash.
 * @throws Error with the build messages when the build fails.
 */
export async function buildFirmware(
  source: string,
  baseDir: string,
  packaged?: PackagedBuild,
): Promise<Firmware> {
  // Bundles keep bare imports for externals and resolve them from their own location.
  // @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
  const appDir = packaged?.appDir ?? baseDir;
  const direct = packaged?.outdir !== undefined;
  const firmwareDir = packaged?.outdir ?? join(baseDir, ".rack", "firmware");
  if (!direct) await privateRackDir(baseDir);
  // @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
  const outdir = direct ? firmwareDir : `${firmwareDir}-${process.pid}-${++builds}`;
  const external =
    packaged === undefined
      ? ["racku", ...(await declaredDependencies(dirname(source), appDir))]
      : [];
  // @decision .agents/decisions/261120_011627-single-executables.md#compiling-a-rack
  const plugins =
    packaged === undefined
      ? [SOURCE_IMPORT_META]
      : [
          HOST_RACKU,
          ...(packaged.carried === undefined
            ? []
            : [carriedPackages(packaged.carried), insideBaseDir(baseDir)]),
          ...(packaged.record === undefined ? [] : [recordPackages(packaged.record)]),
          packagedImportMeta(packaged.appDir),
        ];
  const tsconfig = await tsconfigFor(dirname(source), appDir, baseDir);
  try {
    let output: Bun.BuildOutput;
    try {
      output = await retryMissedImports(() =>
        Bun.build({
          entrypoints: [source],
          outdir,
          target: "bun",
          sourcemap: "inline",
          naming: "[name]-[hash].[ext]",
          external,
          plugins,
          tsconfig,
          ...NO_MACROS,
        }),
      );
    } catch (error) {
      throw new Error(`firmware build failed for ${source}: ${describeBuildError(error)}`);
    }
    if (!output.success) {
      throw new Error(`firmware build failed for ${source}: ${describeBuildError(output.logs)}`);
    }
    const entry = output.outputs.find((artifact) => artifact.kind === "entry-point");
    if (entry === undefined) {
      throw new Error(`firmware build for ${source} produced no entry point`);
    }
    const name = basename(entry.path).replace(/\.[^.]+$/, "");
    const hash = name.slice(name.lastIndexOf("-") + 1);
    const written = [entry.path, ...output.outputs.filter((o) => o !== entry).map((o) => o.path)];
    const files = direct ? written : await settle(written, firmwareDir);
    const path = files[0] as string;
    return { path, url: Bun.pathToFileURL(path).href, hash, source, files };
  } finally {
    if (!direct) await rm(outdir, { recursive: true, force: true });
  }
}

/**
 * Turns macros off in a build: `macros: false`, which Bun 1.4.4 takes, while its types leave the
 * option out. A device file whose imports include a macro then fails to build, with Bun's
 * "Macros are disabled", instead of running code in the process that builds it.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export const NO_MACROS: object = { macros: false };

/** Builds that this process started, which name their directories. */
let builds = 0;

/**
 * Moves the files of a build into `dir`, each unless a file of its name is there already; the
 * names hold the hash of their contents, so that file has the same bytes. A rename can't leave a
 * file half written.
 *
 * @returns The paths of the files in `dir`, in the order given.
 */
async function settle(written: readonly string[], dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const path of written) {
    const target = join(dir, basename(path));
    if (!existsSync(target)) {
      await rename(path, target).catch((error: unknown) => {
        // Another build of the same file got there first, as a rack and rack plan can.
        if (!existsSync(target)) throw error;
      });
    }
    files.push(target);
  }
  return files;
}

/**
 * The `tsconfig.json` that a build reads: the closest one to the device file, from its directory
 * up to the app's directory, but none above it; for a device file outside the app, such as one
 * of racku's own, up to the directory of its package. Without one, the build reads an empty one,
 * `.rack/no-tsconfig.json`, in place of any that Bun would otherwise find in a directory above.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export async function tsconfigFor(dir: string, appDir: string, baseDir: string): Promise<string> {
  const found = closest(dir, appDir, "tsconfig.json");
  if (found !== undefined) return found;
  const none = join(baseDir, ".rack", "no-tsconfig.json");
  if (existsSync(none)) return none;
  // Builds that start together share one write.
  let writing = emptyTsconfigs.get(none);
  if (writing === undefined) {
    writing = (async () => {
      await privateRackDir(baseDir);
      // A new file renamed into place, so that a build at the same time never reads half of it.
      const draft = `${none}.${process.pid}-${++builds}.tmp`;
      await writeFile(draft, "{}\n");
      await rename(draft, none).catch((error: unknown) => {
        // Another process put it there first.
        if (!existsSync(none)) throw error;
      });
    })().finally(() => emptyTsconfigs.delete(none));
    emptyTsconfigs.set(none, writing);
  }
  await writing;
  return none;
}

/** The writes of `.rack/no-tsconfig.json` under way, by path. */
const emptyTsconfigs = new Map<string, Promise<void>>();

/**
 * The closest file of `name` from `dir` upward: up to `appDir` when `dir` lies in it, and
 * otherwise up to the first directory with a `package.json`, the root of a package.
 */
function closest(dir: string, appDir: string, name: string): string | undefined {
  const inside = within(dir, appDir);
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, name);
    if (existsSync(candidate)) return candidate;
    if (inside ? current === appDir : existsSync(join(current, "package.json"))) return undefined;
    if (dirname(current) === current) return undefined;
  }
}

/** Base directories whose `.rack/` this process made private already. */
const privateDirs = new Set<string>();

/**
 * Makes `<baseDir>/.rack/`, and gives it mode 0700, also when it existed, so that its bundles,
 * plan, and records are only its user's: a bundle holds what the device imports, such as a JSON
 * file of secrets. On Windows, `.rack/` keeps the access of the folder that holds it.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export async function privateRackDir(baseDir: string): Promise<void> {
  if (privateDirs.has(baseDir)) return;
  const dir = join(baseDir, ".rack");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700);
  privateDirs.add(baseDir);
}

/**
 * Deletes from `<baseDir>/.rack/firmware/` the files that `keep` doesn't name and that were
 * written before `before`, such as the firmware of earlier runs and of `rack plan`, and the build
 * directories of processes that ended. A rack runs it at its start, once it holds the base
 * directory's management endpoint, so that no other rack uses them.
 *
 * @param keep The files of the firmware that the rack needs.
 * @param before A millisecond timestamp; files written since are left to the next start.
 * @param runs Whether the process with an id runs, for the build directories.
 * @returns How many files it deleted.
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export async function sweepFirmware(
  baseDir: string,
  keep: ReadonlySet<string>,
  before: number,
  runs: (pid: number) => boolean,
): Promise<number> {
  const rack = join(baseDir, ".rack");
  const firmwareDir = join(rack, "firmware");
  let deleted = 0;
  for (const name of await readdir(firmwareDir).catch(() => [] as string[])) {
    const path = join(firmwareDir, name);
    if (keep.has(path)) continue;
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.mtimeMs >= before) continue;
    await rm(path, { force: true });
    deleted++;
  }
  for (const name of await readdir(rack).catch(() => [] as string[])) {
    const pid = /^firmware-(\d+)-\d+$/.exec(name)?.[1];
    if (pid === undefined || runs(Number(pid))) continue;
    await rm(join(rack, name), { recursive: true, force: true });
  }
  return deleted;
}

/**
 * Says why a bundle can't import a package that it keeps external, when the bundle's location is
 * the cause. A bundle imports those packages from its own directory, `<baseDir>/.rack/firmware/`,
 * so a base directory outside the app finds none of them, though the device file finds them all.
 *
 * Only the failure path resolves the package, from the device file's directory: the directory of
 * the bundles is left to the Workers, whose imports work around Bun's cache of directory entries.
 *
 * @param message The message of the error that loading the bundle threw.
 * @param firmware The bundle.
 * @param baseDir The rack's base directory, which holds the bundle.
 * @returns A clause to append to the message: `""` when the message is about something else, or
 *   when the device file can't import the package either, as when the app lacks it. racku runs
 *   this code, so an app has it.
 */
export function explainMissingPackage(
  message: string,
  firmware: Firmware,
  baseDir: string,
): string {
  const name = /Cannot find package '([^']+)'/.exec(message)?.[1];
  if (name === undefined) return "";
  if (name !== "racku") {
    try {
      Bun.resolveSync(name, dirname(firmware.source));
    } catch {
      return ""; // The device file can't import it either: the app lacks the package.
    }
  }
  return `; firmware imports its packages from .rack/firmware/ under the base directory, so the base directory, ${baseDir}, must lie inside the app, below the node_modules that holds ${name}`;
}

/** Attempts in all at importing a bundle that Bun reports missing while it is on disk. */
const IMPORT_ATTEMPTS = 4;
/** Milliseconds between two of those attempts. */
const IMPORT_PAUSE = 10;

/**
 * Imports a firmware bundle in the Worker that runs or describes its device.
 *
 * Bun 1.4.4 can report a bundle missing while it is on disk. Its module resolver keeps the
 * entries of each directory in one cache for the whole process. When a lookup of a file written
 * after its directory was cached misses, Bun clears the directory from the cache and looks once
 * more, but only if its own clear removed something. So when two Workers miss in one directory
 * at the same time, the second clear removes nothing, and that Worker's miss is final; another
 * `import()` finds the file. A rack writes every bundle into a directory that earlier Workers
 * have cached, and starts several Workers together, so a bundle that Bun reports missing while it
 * is on disk is imported again, up to {@link IMPORT_ATTEMPTS} times in all.
 *
 * @param url `file:` URL of the bundle.
 * @param load Imports a URL; `import()` unless a test replaces it.
 * @returns The bundle's module namespace object.
 * @throws The import's error, unchanged: when the bundle throws while it loads, when a module it
 *   imports can't be found, when the bundle isn't on disk, or when every attempt misses it.
 */
export async function importFirmware(
  url: string,
  load: (url: string) => Promise<unknown> = (target) => import(target),
): Promise<unknown> {
  const path = Bun.fileURLToPath(url);
  for (let attempt = 1; ; attempt++) {
    try {
      return await load(url);
    } catch (error) {
      if (attempt >= IMPORT_ATTEMPTS || !reportsMissing(error, url, path)) throw error;
      if (!(await Bun.file(path).exists())) throw error;
    }
    await Bun.sleep(IMPORT_PAUSE);
  }
}

/** Attempts in all at a build whose relative imports Bun reports missing while they are on disk. */
const BUILD_ATTEMPTS = 4;
/** Milliseconds between two of those attempts. */
const BUILD_PAUSE = 10;
/** What Bun adds to a relative import without an extension, the import as it is first. */
const IMPORT_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * Runs a build, and runs it again when it failed only because Bun reported relative imports
 * missing whose files are on disk, up to {@link BUILD_ATTEMPTS} times in all.
 *
 * Bun 1.4.4's bundler resolves imports through the same process-wide cache of directory entries
 * as `import()`, which {@link importFirmware} describes, with the same flaw: of two threads that
 * miss in one directory at once, one misses for good. A file written after its directory was
 * cached can so fail a build: in an executable on two CPUs, a `connectors.ts` written to the base
 * directory after the rack started failed 2 of 30 `ctl reload`s with "Could not resolve", and
 * none of 60 once a failed build was run again.
 *
 * @param build Runs the build once; `Bun.build` with the firmware's options.
 * @returns What the build returned.
 * @throws The build's error, unchanged: when it failed for another reason, or every attempt did.
 */
export async function retryMissedImports<T>(build: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await build();
    } catch (error) {
      if (attempt >= BUILD_ATTEMPTS || !missesFilesOnDisk(error)) throw error;
    }
    await Bun.sleep(BUILD_PAUSE);
  }
}

/**
 * Whether every error of a failed build is Bun's report of a relative import missing, whose file
 * is on disk.
 */
function missesFilesOnDisk(error: unknown): boolean {
  const all = error instanceof AggregateError ? error.errors : [];
  const errors = all.filter((item) => (item as { level?: unknown } | null)?.level !== "warning");
  return (
    errors.length > 0 &&
    errors.every((item) => {
      const { code, specifier, position } = (item ?? {}) as {
        code?: unknown;
        specifier?: unknown;
        position?: { file?: string } | null;
      };
      const importer = position?.file;
      if (code !== "ERR_MODULE_NOT_FOUND" || typeof specifier !== "string" || !importer) {
        return false;
      }
      if (!/^\.\.?[\\/]/.test(specifier)) return false;
      const target = resolve(dirname(importer), specifier);
      return IMPORT_EXTENSIONS.some((extension) => existsSync(target + extension));
    })
  );
}

/** Whether `error` is Bun's report that the module at `url`, whose path is `path`, is missing. */
function reportsMissing(error: unknown, url: string, path: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, specifier } = error as { code?: unknown; specifier?: unknown };
  return code === "ERR_MODULE_NOT_FOUND" && (specifier === path || specifier === url);
}

/**
 * Lists the dependencies of the `package.json` closest to `dir`, or none when there is none: with
 * `appDir`, none above the app's directory, for a `dir` inside it.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export async function declaredDependencies(dir: string, appDir?: string): Promise<string[]> {
  const inside = appDir !== undefined && within(dir, appDir);
  for (let current = dir; ; current = dirname(current)) {
    const file = Bun.file(join(current, "package.json"));
    if (await file.exists()) {
      const manifest = (await file.json()) as Record<string, unknown>;
      const names = new Set<string>();
      for (const field of DEPENDENCY_FIELDS) {
        const deps = manifest[field];
        if (typeof deps === "object" && deps !== null) {
          for (const dep of Object.keys(deps)) names.add(dep);
        }
      }
      return [...names];
    }
    if ((inside && current === appDir) || dirname(current) === current) return [];
  }
}

/** Joins the messages of a failed build, its errors only when it has any, with their places. */
export function describeBuildError(error: unknown): string {
  const all: unknown[] =
    error instanceof AggregateError ? error.errors : Array.isArray(error) ? error : [error];
  const errors = all.filter((item) => (item as { level?: unknown } | null)?.level !== "warning");
  const lines = (errors.length > 0 ? errors : all).map((item) => {
    if (typeof item !== "object" || item === null) return String(item);
    const { message, position } = item as {
      message?: unknown;
      position?: { file?: string; line?: number; column?: number } | null;
    };
    const text = typeof message === "string" ? message : String(item);
    if (!position?.file) return text;
    return `${position.file}:${position.line ?? 0}:${position.column ?? 0}: ${text}`;
  });
  return lines.join("; ") || "unknown error";
}
