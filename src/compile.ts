/**
 * `rack compile`: packages a rack into one executable with the `compile` option of `Bun.build`.
 * The executable holds the manifest, the rack runtime and its Worker host, the firmware of every
 * device that the manifest mounts, and the packages that the app declares and the firmware
 * imports, for firmware built from outside files.
 *
 * The firmware is built as an executable builds outside files: rack42u comes from the Worker
 * host, and `import.meta` paths are the executable's, which the same plugin gives the manifest
 * and the modules of rack42u in the executable; see `packaged.ts`.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md#compiling-a-rack
 */
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFirmware,
  declaredDependencies,
  describeBuildError,
  packagedImportMeta,
} from "./firmware.ts";
import type { RackManifest } from "./manifest.ts";
import { fileKey, type PackagedTable } from "./packaged.ts";
import { deviceFiles } from "./rack.ts";

/** rack42u's own directory, whose `src/` the executable's entries import. */
const PACKAGE_DIR = realpathSync(join(import.meta.dir, ".."));

/** Options of {@link compileRack}. */
export interface CompileOptions {
  /**
   * The executable's path; by default the rack's name, next to the manifest, with `.exe` for
   * Windows.
   */
  outfile?: string;
  /** One of Bun's targets, such as `bun-windows-x64`; by default the system that compiles. */
  target?: string;
}

/** What {@link compileRack} wrote. */
export interface CompileResult {
  outfile: string;
  /** The executable's size in bytes. */
  size: number;
  /** Each packaged device file, by its path from the manifest's directory, with its hash. */
  devices: { file: string; hash: string }[];
}

/**
 * Packages a rack into one executable.
 *
 * @param manifestPath The manifest's absolute path.
 * @param manifest The manifest, loaded from that path.
 * @returns What it wrote.
 * @throws Error with the build's messages when a device file, or the executable, fails to build;
 *   no executable is written then.
 */
export async function compileRack(
  manifestPath: string,
  manifest: RackManifest,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const appDir = realpathSync(dirname(manifestPath));
  // Inside the app, so that the packages the entries import resolve from its node_modules.
  const work = join(appDir, ".rack", "compile");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const sources = new Map<string, string>();
    const add = (path: string): string => {
      const real = realpathSync(path);
      const key = fileKey(real, appDir);
      sources.set(key, real);
      return key;
    };
    const scans: PackagedTable["scans"] = {};
    if (manifest.scan === undefined) {
      for (const { spec } of manifest.slots) add(sourcePath(spec.source, appDir));
    } else {
      for (const entry of manifest.scan.devices) {
        if (typeof entry === "string") {
          const dir = resolve(appDir, entry);
          scans[fileKey(realpathSync(dir), appDir)] = (await deviceFiles(dir)).map(add);
        } else {
          add(sourcePath(entry.source, appDir));
        }
      }
    }

    const declared = new Set(await declaredDependencies(appDir));
    declared.delete("rack42u");
    const found = new Set<string>();
    const devices: PackagedTable["devices"] = {};
    const listed: CompileResult["devices"] = [];
    const firmwareFiles: string[] = [];
    for (const [key, source] of sources) {
      const firmware = await buildFirmware(source, appDir, {
        appDir,
        outdir: join(work, "firmware"),
        record: { declared, found },
      });
      firmwareFiles.push(firmware.path);
      devices[key] = { file: slashes(relative(work, firmware.path)), hash: firmware.hash };
      listed.push({ file: slashes(relative(appDir, source)), hash: firmware.hash });
    }

    const carried: PackagedTable["carried"] = {};
    const carriedFiles: string[] = [];
    for (const [index, specifier] of [...found].sort().entries()) {
      const file = join(work, "carried", `${index}.ts`);
      const name = JSON.stringify(specifier);
      await Bun.write(
        file,
        `export * from ${name};\nimport * as all from ${name};\nexport default (all as { default?: unknown }).default;\n`,
      );
      carriedFiles.push(file);
      carried[specifier] = `carried/${index}.js`;
    }

    const plans: PackagedTable["plans"] = {};
    if (manifest.scan !== undefined) {
      const name = `${manifest.name}.plan`;
      const file = Bun.file(join(appDir, name));
      if (await file.exists()) plans[name] = await file.text();
    }

    const table: PackagedTable = {
      rack: manifest.name,
      worker: "worker.js",
      devices,
      carried,
      scans,
      plans,
    };
    const src = (file: string) => JSON.stringify(slashes(join(PACKAGE_DIR, "src", file)));
    // The prelude runs first in both entries: packaged modules call what it installs for their
    // import.meta paths as they load.
    await Bun.write(
      join(work, "prelude.ts"),
      [
        'import { fileURLToPath } from "node:url";',
        `import { installImportMeta } from ${src("packaged.ts")};`,
        'installImportMeta(fileURLToPath(new URL(".", import.meta.url)));',
        "",
      ].join("\n"),
    );
    await Bun.write(
      join(work, "main.ts"),
      [
        'import "./prelude.ts";',
        `import { runExecutable } from ${src("executable.ts")};`,
        `await runExecutable(${JSON.stringify(table)}, () => import(${JSON.stringify(slashes(manifestPath))}));`,
        "",
      ].join("\n"),
    );
    await Bun.write(
      join(work, "worker.ts"),
      [
        'import "./prelude.ts";',
        `import * as rack42u from ${src("index.ts")};`,
        `import { HOST_MODULES } from ${src("packaged.ts")};`,
        `import * as std from ${src("std/index.ts")};`,
        `import ${src("worker.ts")};`,
        "// Firmware takes rack42u from here, so it shares the host's copy.",
        '(globalThis as Record<symbol, unknown>)[HOST_MODULES] = { rack42u, "rack42u/std": std };',
        "",
      ].join("\n"),
    );

    const target = options.target;
    const windows =
      target === undefined ? process.platform === "win32" : target.includes("windows");
    let outfile = resolve(options.outfile ?? join(dirname(manifestPath), manifest.name));
    if (windows && !outfile.toLowerCase().endsWith(".exe")) outfile += ".exe";
    const generated = `${work}${sep}`;
    let output: Bun.BuildOutput;
    try {
      output = await Bun.build({
        // The first entry point is the executable's main module.
        entrypoints: [
          join(work, "main.ts"),
          join(work, "worker.ts"),
          ...firmwareFiles,
          ...carriedFiles,
        ],
        target: "bun",
        compile: {
          outfile,
          ...(target === undefined ? {} : { target: target as Bun.Build.CompileTarget }),
        },
        plugins: [packagedImportMeta(appDir, (path) => path.startsWith(generated))],
      });
    } catch (error) {
      throw new Error(`the executable failed to build: ${describeBuildError(error)}`);
    }
    if (!output.success) {
      throw new Error(`the executable failed to build: ${describeBuildError(output.logs)}`);
    }
    return { outfile, size: Bun.file(outfile).size, devices: listed };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The path of a device file that the manifest names, relative to the manifest's directory. */
function sourcePath(source: string | URL, appDir: string): string {
  return source instanceof URL ? fileURLToPath(source) : resolve(appDir, source);
}

/** A path with `/` between its parts. */
function slashes(path: string): string {
  return path.split(sep).join("/");
}
