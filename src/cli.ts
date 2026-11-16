#!/usr/bin/env bun
/**
 * The `rack` command line: `rack start [manifest]` and `rack dev [manifest]`.
 *
 * Both commands load the manifest, which references devices only by path, start the rack with
 * the manifest's directory as the base directory, and shut down in order on `SIGINT` or
 * `SIGTERM`.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#command-line
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 */
import { dirname, resolve } from "node:path";
import { watchAndReload } from "./dev.ts";
import { RackError } from "./errors.ts";
import { consoleLogger } from "./log.ts";
import { isRackManifest } from "./manifest.ts";
import { type RackHandle, start } from "./rack.ts";

const USAGE = "usage: rack <start|dev> [manifest path, default rack.ts]";

function fail(message: string): never {
  console.error(`rack: ${message}`);
  process.exit(1);
}

function describe(error: unknown): string {
  const code = error instanceof RackError ? `${error.code}: ` : "";
  return `${code}${error instanceof Error ? error.message : String(error)}`;
}

async function main(args: string[]): Promise<void> {
  const [command, manifestArg = "rack.ts", ...rest] = args;
  if ((command !== "start" && command !== "dev") || rest.length > 0) {
    console.error(USAGE);
    process.exit(2);
  }

  let running: RackHandle | undefined;
  let unwatch: (() => void) | undefined;
  let stopping = false;
  const stop = (rack: RackHandle) =>
    rack.stop().then(
      () => process.exit(0),
      (error: unknown) => fail(`shutdown failed: ${describe(error)}`),
    );
  // Installed before the rack starts, so a signal during start-up still shuts down in order.
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      console.error(`rack: ${signal} again, exiting without finishing the shutdown`);
      process.exit(1);
    }
    stopping = true;
    unwatch?.();
    if (running !== undefined) void stop(running);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const manifestPath = resolve(manifestArg);
  let manifest: unknown;
  try {
    manifest = ((await import(manifestPath)) as { default?: unknown }).default;
  } catch (error) {
    fail(`cannot load ${manifestPath}: ${describe(error)}`);
  }
  if (!isRackManifest(manifest)) fail(`${manifestPath} does not default-export a rack()`);

  const baseDir = dirname(manifestPath);
  try {
    running = await start(manifest, { baseDir, logger: consoleLogger });
  } catch (error) {
    fail(describe(error));
  }
  if (stopping) {
    await stop(running);
    return;
  }
  if (command === "dev") {
    unwatch = watchAndReload(running, { baseDir, manifestPath, log: consoleLogger });
  }
}

await main(process.argv.slice(2));
