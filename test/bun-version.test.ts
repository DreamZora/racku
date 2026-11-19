/**
 * Every place that names the minimum Bun version names the same one, so that a move of the minimum
 * moves them all, and the README's "or later" stays backed by a job on the latest Bun release.
 *
 * @decision .agents/decisions/261119_054816-versions-and-bun.md#a-minimum-bun-not-a-pinned-one
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT } from "./fixtures/app.ts";

const read = (path: string) => Bun.file(join(ROOT, path)).text();

/** How a job of the workflow names the minimum: the workflow's `BUN_MINIMUM`. */
const MINIMUM = `\${{ env.BUN_MINIMUM }}`;

// @doc README.md#requirements
test("the minimum Bun version is the same in every place that names it", async () => {
  const manifest = JSON.parse(await read("package.json")) as {
    engines: { bun: string };
    devDependencies: Record<string, string>;
  };
  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines.bun)?.[1] ?? "";
  expect(minimum).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.devDependencies["@types/bun"]).toBe(minimum);

  const workflow = await read(".github/workflows/check.yml");
  expect(/^ {2}BUN_MINIMUM: "(.+)"$/m.exec(workflow)?.[1]).toBe(minimum);

  const readme = await read("README.md");
  expect(readme).toContain(`[Bun](https://bun.sh) ${minimum} or later.`);
  expect(readme).toContain(
    `CI tests ${minimum} on every system, and the latest Bun release on Linux.`,
  );

  const agents = await read("AGENTS.md");
  expect(agents).toContain(`- The minimum is ${minimum}:`);
  expect(agents).toContain(`\`engines.bun\` names it as \`>=${minimum}\`.`);
});

// @doc README.md#requirements
test("CI runs the minimum on every system, and the latest Bun release on Linux", async () => {
  const workflow = await read(".github/workflows/check.yml");
  // Each job's name, runner, and Bun version, in the order the workflow lists them.
  const jobs = [
    ...workflow.matchAll(/^ {4}name: (.+)\n {4}runs-on: (.+)\n[\s\S]*?bun-version: (.+)$/gm),
  ];
  expect(jobs.map(([, name, runner, version]) => [name, runner, version])).toEqual([
    ["Linux", "ubuntu-latest", MINIMUM],
    ["macOS", "macos-latest", MINIMUM],
    ["Windows", "windows-latest", MINIMUM],
    ["Linux, latest Bun", "ubuntu-latest", "latest"],
  ]);
  expect(workflow).not.toContain("continue-on-error");
});
