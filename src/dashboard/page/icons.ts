/**
 * The icons of states, levels, and outcomes. Each pairs a shape with a glyph, and the page sets a
 * word beside it, so that no state shows by color alone.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 */
import type { SlotState } from "../../reports.ts";
import { svg } from "./dom.ts";

/** The colors an icon takes: the status palette's, and two of the page's own. */
export type Tone = "good" | "info" | "warning" | "serious" | "critical" | "neutral";

type Shape = "circle" | "triangle" | "square";

/** The glyphs, drawn with round strokes in a 16 × 16 box. */
const GLYPHS = {
  check: "M4.7 8.3 7 10.6l4.4-4.9",
  swap: "M4.4 6.2h7l-2-2M11.6 9.8h-7l2 2",
  bang: "M8 5.6v3.3M8 11.5v.1",
  reset: "M11.2 6.1A3.6 3.6 0 1 0 11.6 9.2M11.5 3.8v2.5H9",
  cross: "M5.5 5.5l5 5M10.5 5.5l-5 5",
  info: "M8 7.3v3.8M8 4.8v.1",
  wait: "M5 8h.1M8 8h.1M11 8h.1",
} as const;

type Glyph = keyof typeof GLYPHS;

/** What an icon is made of. */
interface Look {
  shape: Shape;
  glyph: Glyph;
  tone: Tone;
}

/** The icon of each state of a slot. */
export const STATE_LOOKS: Record<SlotState, Look> = {
  online: { shape: "circle", glyph: "check", tone: "good" },
  swapping: { shape: "circle", glyph: "swap", tone: "info" },
  degraded: { shape: "triangle", glyph: "bang", tone: "warning" },
  resetting: { shape: "circle", glyph: "reset", tone: "serious" },
  faulted: { shape: "square", glyph: "cross", tone: "critical" },
};

const OTHER_LOOKS = {
  info: { shape: "circle", glyph: "info", tone: "neutral" },
  warn: { shape: "triangle", glyph: "bang", tone: "warning" },
  error: { shape: "square", glyph: "cross", tone: "critical" },
  debug: { shape: "circle", glyph: "info", tone: "neutral" },
  ok: { shape: "circle", glyph: "check", tone: "good" },
  failed: { shape: "square", glyph: "cross", tone: "critical" },
  live: { shape: "circle", glyph: "check", tone: "good" },
  down: { shape: "square", glyph: "cross", tone: "critical" },
  waiting: { shape: "circle", glyph: "wait", tone: "neutral" },
} as const satisfies Record<string, Look>;

/** The names of the icons. */
export type IconName = SlotState | keyof typeof OTHER_LOOKS;

/**
 * Makes an icon. It is hidden from screen readers: the word beside it says the same.
 *
 * @param name The icon.
 * @returns An SVG element of the class `icon` and of its tone, such as `tone-good`.
 */
export function icon(name: IconName): SVGSVGElement {
  // A state or level that a later racku adds gets a neutral icon; its word still names it.
  const look: Look = Object.hasOwn(STATE_LOOKS, name)
    ? STATE_LOOKS[name as SlotState]
    : Object.hasOwn(OTHER_LOOKS, name)
      ? OTHER_LOOKS[name as keyof typeof OTHER_LOOKS]
      : OTHER_LOOKS.info;
  return svg(
    "svg",
    {
      class: `icon tone-${look.tone}`,
      viewBox: "0 0 16 16",
      "aria-hidden": "true",
      focusable: "false",
    },
    shape(look.shape),
    svg("path", { class: "glyph", d: GLYPHS[look.glyph] }),
  );
}

function shape(kind: Shape): SVGElement {
  switch (kind) {
    case "triangle":
      return svg("path", { class: "shape", d: "M8 1.3 15.3 14.4H.7Z" });
    case "square":
      return svg("rect", { class: "shape", x: 1, y: 1, width: 14, height: 14, rx: 3.5 });
    default:
      return svg("circle", { class: "shape", cx: 8, cy: 8, r: 7.3 });
  }
}
