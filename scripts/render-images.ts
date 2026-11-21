/**
 * Renders the README's image: `docs/images/rack.html` to `docs/images/rack.png`, with the Chrome
 * or Chromium of the machine, headless, at {@link WIDTH} × {@link HEIGHT} pixels and twice their
 * density. It then writes the first 12 hex digits of the SHA-256 of the HTML into the comment
 * beside the image in the README, which `test/readme.test.ts` compares with the HTML, so that an
 * edit of the source without a new rendering fails.
 *
 * Run it as `bun run render:images`. `CHROME` names the browser when it isn't on `PATH` as one of
 * {@link BROWSERS}.
 *
 * @decision .agents/decisions/261121_044629-readme-at-a-glance.md#the-image
 */
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The size of the page in CSS pixels, which `rack.html` lays out. */
export const WIDTH = 880;
export const HEIGHT = 452;
/** How many device pixels the image has per CSS pixel. */
export const DENSITY = 2;
/** The browsers looked for on `PATH`, in this order. */
export const BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

const ROOT = join(import.meta.dir, "..");
export const SOURCE = join(ROOT, "docs", "images", "rack.html");
export const IMAGE = join(ROOT, "docs", "images", "rack.png");
const README = join(ROOT, "README.md");
/** The comment beside the image in the README, with the hash of the source it was rendered from. */
export const HASH_COMMENT = /<!-- docs\/images\/rack\.html ([0-9a-f]{12}) -->/;

/** The first 12 hex digits of the SHA-256 of the image's source. */
export async function sourceHash(): Promise<string> {
  const bytes = await Bun.file(SOURCE).arrayBuffer();
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12);
}

function fail(message: string): never {
  console.error(`render-images: ${message}`);
  process.exit(1);
}

if (import.meta.main) {
  const chrome = process.env.CHROME || BROWSERS.map((name) => Bun.which(name)).find(Boolean);
  if (chrome === undefined || chrome === null) {
    fail(`no Chrome or Chromium on PATH as ${BROWSERS.join(", ")}; set CHROME to its path`);
  }
  // A new file, renamed over the image once it is complete, so that a failed rendering leaves
  // the committed image as it is.
  const next = `${IMAGE}.new.png`;
  await rm(next, { force: true });
  const done = Bun.spawnSync(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--force-device-scale-factor=${DENSITY}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${next}`,
      pathToFileURL(SOURCE).href,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (done.exitCode !== 0 || !existsSync(next)) {
    await rm(next, { force: true });
    fail(`${chrome} exited with ${done.exitCode}: ${done.stderr.toString().trim()}`);
  }
  await rename(next, IMAGE);
  const readme = await Bun.file(README).text();
  if (!HASH_COMMENT.test(readme)) fail("README.md has no comment for the image's hash");
  const hash = await sourceHash();
  await Bun.write(README, readme.replace(HASH_COMMENT, `<!-- docs/images/rack.html ${hash} -->`));
  console.log(`render-images: docs/images/rack.png, from docs/images/rack.html ${hash}`);
}
