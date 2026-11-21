/**
 * The window's icons, as SVG paths in a 24 × 24 box that Quasar's `q-icon` draws: `d@@style`,
 * several joined with `&&`. They are drawn here, since Quasar's icon fonts aren't among the
 * example's packages.
 */
const stroke = "fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round";

export const icons = {
  /** A rack of three units, each with a light. */
  rack: "M3 4h18v4H3zM15.5 5.25h3v1.5h-3zM3 10h18v4H3zM15.5 11.25h3v1.5h-3zM3 16h18v4H3zM15.5 17.25h3v1.5h-3z@@fill-rule:evenodd",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  close: "M6.7 5.3 12 10.6l5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3z",
  send: "M3 3.5 21 12 3 20.5 5.6 12z",
  copy: `M9 9h11v11H9z@@${stroke}&&M5 15H4V4h11v1@@${stroke}`,
  reload: `M20 12a8 8 0 1 1-2.6-5.9@@${stroke}&&M20 4v4.5h-4.5@@${stroke}`,
  check: `M5 12.5 9.5 17 19 7.5@@${stroke}`,
};
