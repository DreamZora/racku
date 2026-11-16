/**
 * Firmware builds: each device file becomes one hashed bundle, and the hash is its version.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 * @decision .agents/decisions/261112_035943-hot-swap.md#firmware
 */
import { basename, dirname, join } from "node:path";

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
 * @param source Absolute path of the device file.
 * @param baseDir Rack base directory; firmware must live inside the app directory.
 * @returns The bundle and its hash.
 * @throws Error with the build messages when the build fails.
 */
export async function buildFirmware(source: string, baseDir: string): Promise<Firmware> {
  // Bundles keep bare imports for externals and resolve them from their own location.
  // @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
  const outdir = join(baseDir, ".rack", "firmware");
  const external = ["rack42u", ...(await declaredDependencies(dirname(source)))];
  let output: Bun.BuildOutput;
  try {
    output = await Bun.build({
      entrypoints: [source],
      outdir,
      target: "bun",
      sourcemap: "inline",
      naming: "[name]-[hash].[ext]",
      external,
    });
  } catch (error) {
    throw new Error(`firmware build failed for ${source}: ${describeBuildError(error)}`);
  }
  if (!output.success) {
    throw new Error(`firmware build failed for ${source}: ${describeBuildError(output.logs)}`);
  }
  const entry = output.outputs.find((artifact) => artifact.kind === "entry-point");
  if (entry === undefined) throw new Error(`firmware build for ${source} produced no entry point`);
  const name = basename(entry.path).replace(/\.[^.]+$/, "");
  const hash = name.slice(name.lastIndexOf("-") + 1);
  return { path: entry.path, url: Bun.pathToFileURL(entry.path).href, hash, source };
}

/** Lists the dependencies of the `package.json` closest to `dir`, or none when there is none. */
async function declaredDependencies(dir: string): Promise<string[]> {
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
    if (dirname(current) === current) return [];
  }
}

function describeBuildError(error: unknown): string {
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
