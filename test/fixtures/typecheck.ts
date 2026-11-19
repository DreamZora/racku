/**
 * Type-checks the files of an app that the documentation shows, against the sources of rack42u.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./app.ts";

/**
 * Writes `files` into a temporary directory, and type-checks them with this repository's settings,
 * with `rack42u`, its subpaths, and valibot resolved to this repository.
 *
 * @param files The contents of each file, by its path in the app.
 * @returns What `tsc` printed; empty when the files type-check.
 * @throws When this repository's `tsc` can't be found.
 */
export async function typecheck(files: ReadonlyMap<string, string>): Promise<string> {
  const tsc = Bun.which("tsc", { PATH: join(ROOT, "node_modules", ".bin") });
  if (tsc === null) throw new Error("no tsc under node_modules/.bin; run bun install");
  const dir = await mkdtemp(join(tmpdir(), "rack42u-typecheck-"));
  try {
    for (const [path, code] of files) await Bun.write(join(dir, path), code);
    const at = (path: string) => join(ROOT, path);
    const config = {
      extends: at("tsconfig.json"),
      compilerOptions: {
        typeRoots: [at(join("node_modules", "@types"))],
        paths: {
          rack42u: [at(join("src", "index.ts"))],
          "rack42u/std": [at(join("src", "std", "index.ts"))],
          "rack42u/bench": [at(join("src", "bench.ts"))],
          valibot: [at(join("node_modules", "valibot"))],
        },
      },
      include: ["**/*.ts"],
      exclude: [],
    };
    await Bun.write(join(dir, "tsconfig.json"), JSON.stringify(config));
    const run = Bun.spawn([tsc, "-p", join(dir, "tsconfig.json")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    return (stdout + stderr).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
