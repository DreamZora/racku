# Decision: A README read at a glance, with an image rendered from HTML and a minimal hot-reload example

Status: accepted

## Background

- The user on 2026-11-21: "the README has too much prose; it requires careful reading and isn't very engaging. Consider rendering an image with HTML, and adding a minimal hot-reload example."
- [A README that explains rack42u, and complete documentation that tests hold to the code](261119_055008-documentation.md#the-readme) fixes what the README teaches, in order: what rack42u is, the problem, how it solves it "with a diagram", why it is built this way, a quick start, the status, the map of `docs/`, and the requirements, development, and license. Its [writing rules](261119_055008-documentation.md#writing) and [tests](261119_055008-documentation.md#tests-that-hold-the-documentation) hold the README too: an app in code blocks whose first line is `// <path>` runs in a test, and each claim links to the section of a guide or of the reference that holds it.
- Today's README has 128 lines, most of them paragraphs of three to five sentences. Its diagram is text art, and hot reload appears only as a paragraph about `examples/shop-api`, whose devices take 130 lines.
- GitHub shows the images of a README, in its light theme and its dark one alike.
- Google Chrome renders an HTML page to a PNG with `--headless=new --screenshot`, as a mockup of the image did on 2026-11-21, at twice the pixel size for screens of high density.
- Goals: the documentation serves builders who haven't read the code, as the documentation decision says; maintainability: the image has a source that a person can edit, and a test that notices when it falls out of step.

## Decision

### The README's shape

The README keeps the documentation decision's order, and says each part in fewer words:

1. **The image**, then the name, one sentence of what rack42u does, and a line of links: the quick start, hot reload, concepts, and the documentation.
2. **The problem and the answer**, as one table: what goes wrong in one Bun process, and what a rack does instead, one row each for code that doesn't swap, a fault that ends the process, and work that nothing bounds or watches.
3. **Hot reload in a minute**, the new minimal example below.
4. **How it works**: devices in Workers, connectors, swaps, and supervision, one line each with a link to its section of [Concepts](../../docs/concepts.md). The image takes the place of the text diagram.
5. **Why it is built this way**: the four goals in one line, and the main choices as a table of a choice and its reason, with the link to [Design](../../docs/design.md).
6. **Quick start**: `examples/shop-api`, its commands and its curl session as now, and a line each for `examples/net-tool` and [Getting started](../../docs/getting-started.md).
7. **Status**, **Documentation**, **Requirements**, **Development**, and **License**, as now, in shorter lines.

A paragraph has at most two sentences; anything longer becomes a list or a table.

### The image

- `docs/images/rack.html` is its source: one page with no scripts and no remote resources, in a dark theme, which the user chose for every reader. It shows a rack of four devices, one of them in a hot swap from one firmware hash to another, the links between them, the main thread below them, and three cards: hot swaps, faults that stay in their device, and updates that fall back.
- `scripts/render-images.ts`, run as `bun run render:images`, renders it with the Chrome or Chromium of the machine, headless, at 880 × 452 pixels and twice their density, into `docs/images/rack.png`, which is committed. `CHROME` names the browser when it isn't found as `google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser`.
- The script also writes the first 12 hex digits of the SHA-256 of `rack.html` into an HTML comment beside the image in the README.
- The README shows the image with `<img>`, at the width of the README, with an `alt` text that says what it shows.
- The image says only what the README says and links to: its cards repeat the README's claims about swaps, faults, and fallback.

### The hot-reload example

Two files, which a reader saves in a clone of the repository:

```ts
// hello/devices/hello.ts
import { device } from "rack42u";
import { Http, httpHandler } from "rack42u/std";

export default device({
  model: "hello",
  provides: { http: Http },
  powerOn: () => ({ http: httpHandler(() => new Response("Hello\n")) }),
});
```

```ts
// hello/rack.ts
import { rack, slot } from "rack42u";
import { httpPanel } from "rack42u/std";

export default rack("hello", {
  slots: {
    1: slot("./devices/hello.ts"),
    2: httpPanel({ port: Number(process.env.PORT ?? 3000), routes: { "/*": "hello.http" } }),
  },
});
```

Then `bun src/cli.ts dev hello/rack.ts`, and `curl localhost:3000` answers `Hello`. The reader changes `Hello` to `Hello again` in `devices/hello.ts`, saves, and the same `curl` answers `Hello again`: the same process and port, while the log says `hello swapped`. A line says that in an app of one's own, the command is `rack dev`.

### Tests

- `test/readme.test.ts` assembles the example's files from the README, as the documentation decision requires of an app, runs `rack dev` with `PORT=0`, and checks the answer before and after the edit that the README describes, the same process, and the log's `hello swapped`.
- It also checks that the PNG exists, at the size that the script renders, and is the one the README's `<img>` names, and that the hash in the README's comment is the hash of `rack.html`, so that an edit of the source without a new rendering fails.
- `examples/shop-api`'s quick start keeps its test, in `test/example.test.ts`.

### Bounds

| What | Bound |
|---|---|
| The image | One PNG of about 200 KiB, in the package, since `files` includes `docs/` |
| A rendering | One run of the browser |

### Failure modes

| Failure | Outcome |
|---|---|
| No Chrome or Chromium on the machine | `render:images` exits with code 1, and says to set `CHROME`. The committed PNGs stay as they are. |
| `rack.html` changes, and nobody renders it | The README test fails on the hash. |

## Alternatives

- **An SVG drawn by hand**: sharp at any size, and a text diff, but typography and layout by coordinates, which a person edits slowly.
- **An image without a source**, drawn in an editor: no tool to keep in the repository, and no way to change the image but by redrawing it.
- **Mermaid in the README**: GitHub renders it, but its diagrams can't show a rack, a swap, or cards, and their look follows GitHub's.
- **Playwright in the repository, to render**: a development dependency of about 100 MiB of browsers, for an image that changes rarely; Chrome or Chromium is on most machines that would render it.
- **A hot-reload example under `examples/`**: one more directory to keep, where the README's code blocks, run by a test, are the example.

## Impact

- `README.md` is rewritten in the shape above. Links into its sections from other documents, such as the anchor `#quick-start`, stay or move with them.
- New: `docs/images/rack.html` and `rack.png`; `scripts/render-images.ts`; the script `render:images` in `package.json`; and `test/readme.test.ts`.
- [A README that explains rack42u](261119_055008-documentation.md) stays as it is: its order holds, and this decision adds the image, the example, and the rule on paragraphs.
- `AGENTS.md`: the repository structure gains `docs/images/`, and the commands `bun run render:images`.
- Costs: about 200 KiB of image in the repository and the package; a browser on the machine that renders it.
- `docs/design.md` loses "single executables" from what isn't built yet, since `rack compile` builds them.

## Implementation

- `README.md` in the shape above, 162 lines, with the image and its hash in the comment `<!-- docs/images/rack.html <hash> -->` beside it.
- `docs/images/rack.html`, and `docs/images/rack.png`, 1760 × 904 pixels and about 205 KiB, which `scripts/render-images.ts` rendered with Google Chrome on 2026-11-21. `bun run render:images` runs it.
- `test/readme.test.ts`: the hot-reload example from the README's code blocks under `rack dev`, with the edit that the README describes, and the image's tag, size, and hash. An edit of `rack.html` without a new rendering failed it, as it should.
- `docs/design.md`: single executables are no longer among what isn't built, and the workaround of Bun's missed files covers builds too.
- `AGENTS.md`: `docs/images/`, `scripts/render-images.ts`, and the command `bun run render:images`.
- [The README's image under "How it works", not at its top](261121_051335-readme-image-under-how-it-works.md) moves the image, at the user's word, from the top of the README.

## Confirmation

- The user accepted this decision on 2026-11-21, after the Agent's report with a mockup of the image in a light theme and a dark one, and chose the dark one. The user's words: "Accept, I'd like rack-dark". So the README shows the dark image to every reader, and the source has that theme only.
