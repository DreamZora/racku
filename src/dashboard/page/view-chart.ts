/**
 * A device's chart: the calls it served and made per second over the last 2 minutes, two lines on
 * one scale, with a legend, a crosshair and a tooltip on hover and on keyboard focus, and its
 * readings as a table.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 */
import { el, replace, svg } from "./dom.ts";
import { formatNumber, formatRate, formatTime, MISSING } from "./format.ts";
import { CHART_SPAN_MS, nearestIndex, niceCeiling, runsOf } from "./geometry.ts";
import type { DevicePoint } from "./rates.ts";

/** The two series, each with the categorical slot of its color, which follows it always. */
const SERIES = [
  { key: "served", label: "served", slot: "series-1" },
  { key: "made", label: "made", slot: "series-2" },
] as const;

const HEIGHT = 140;
const PAD = { top: 10, right: 14, bottom: 22, left: 46 };

/** A device's chart, drawn again with each reading and each second. */
export class ChartView {
  /** The chart's element, a `figure`. */
  readonly root: HTMLElement;
  readonly #plot: HTMLDivElement;
  readonly #tip: HTMLDivElement;
  readonly #legend: HTMLDivElement;
  readonly #rows: HTMLTableSectionElement;
  #points: DevicePoint[] = [];
  #now = 0;
  /** The time of the point that the crosshair marks, so that it stays while the chart moves. */
  #activeTime: number | null = null;
  #tableKey = "";
  #drawKey = "";

  /** @param device The device's name, for the chart's accessible name. */
  constructor(device: string) {
    this.#legend = el("div", { class: "chart-legend" });
    this.#tip = el("div", { class: "chart-tip", attrs: { "aria-live": "polite" } });
    this.#tip.hidden = true;
    this.#plot = el("div", {
      class: "chart-plot",
      attrs: {
        tabindex: "0",
        role: "group",
        "aria-label": `Calls per second of ${device} over the last 2 minutes. The arrow keys read the values.`,
      },
    });
    this.#rows = el("tbody");
    const table = el(
      "details",
      { class: "chart-table" },
      el("summary", null, "Readings as a table"),
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          null,
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              el("th", null, "Time"),
              el("th", { class: "num" }, "Served"),
              el("th", { class: "num" }, "Made"),
              el("th", { class: "num" }, "Failed"),
            ),
          ),
          this.#rows,
        ),
      ),
    );
    this.root = el(
      "figure",
      { class: "chart" },
      this.#legend,
      el("div", { class: "chart-area" }, this.#plot, this.#tip),
      table,
    );
    this.#plot.addEventListener("pointermove", (event) => this.#point(event.clientX));
    this.#plot.addEventListener("pointerleave", () => this.#hide());
    this.#plot.addEventListener("focus", () => this.#step(0));
    this.#plot.addEventListener("blur", () => this.#hide());
    this.#plot.addEventListener("keydown", (event) => this.#key(event));
  }

  /**
   * Draws the chart again.
   *
   * @param points The device's readings, oldest first.
   * @param now The current time, the right end of the chart, a millisecond timestamp.
   */
  update(points: readonly DevicePoint[], now: number): void {
    // The chart moves once a second, and with each reading; other drawings of the page skip it.
    const key = `${points.length}:${points.at(-1)?.time}:${points[0]?.time}:${Math.floor(now / 1000)}:${this.#plot.clientWidth}`;
    if (key === this.#drawKey) return;
    this.#drawKey = key;
    this.#points = [...points];
    this.#now = now;
    this.#draw();
    this.#drawLegend();
    this.#drawTable();
  }

  /** The points within the chart's 2 minutes. */
  #visible(): DevicePoint[] {
    const from = this.#now - CHART_SPAN_MS;
    return this.#points.filter((point) => point.time >= from && point.time <= this.#now);
  }

  #draw(): void {
    const width = Math.max(240, Math.round(this.#plot.clientWidth || 480));
    const plotWidth = width - PAD.left - PAD.right;
    const plotHeight = HEIGHT - PAD.top - PAD.bottom;
    const from = this.#now - CHART_SPAN_MS;
    const visible = this.#visible();
    let largest = 0;
    for (const point of visible) {
      largest = Math.max(largest, point.served ?? 0, point.made ?? 0);
    }
    const top = niceCeiling(largest);
    const x = (time: number) => PAD.left + ((time - from) / CHART_SPAN_MS) * plotWidth;
    const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
    const chart = svg("svg", {
      class: "chart-svg",
      width,
      height: HEIGHT,
      viewBox: `0 0 ${width} ${HEIGHT}`,
      "aria-hidden": "true",
      focusable: "false",
    });
    for (const value of [0, top / 2, top]) {
      chart.append(
        svg("line", {
          class: value === 0 ? "axis" : "grid",
          x1: PAD.left,
          x2: width - PAD.right,
          y1: y(value),
          y2: y(value),
        }),
        svg(
          "text",
          { class: "tick", x: PAD.left - 6, y: y(value) + 4, "text-anchor": "end" },
          `${formatNumber(value)}/s`,
        ),
      );
    }
    const ticks: Array<[number, string, string]> = [
      [from, "2 min ago", "start"],
      [from + CHART_SPAN_MS / 2, "1 min ago", "middle"],
      [this.#now, "now", "end"],
    ];
    for (const [time, label, anchor] of ticks) {
      chart.append(
        svg("text", { class: "tick", x: x(time), y: HEIGHT - 6, "text-anchor": anchor }, label),
      );
    }
    for (const series of SERIES) {
      const runs = runsOf(
        visible.map((point) => ({ time: point.time, value: point[series.key] })),
        from,
        this.#now,
      );
      for (const run of runs) {
        if (run.length === 1) {
          const only = run[0] as { time: number; value: number };
          chart.append(
            svg("circle", {
              class: `dot ${series.slot}`,
              cx: x(only.time),
              cy: y(only.value),
              r: 2.5,
            }),
          );
          continue;
        }
        const d = run
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"}${x(point.time).toFixed(1)} ${y(point.value).toFixed(1)}`,
          )
          .join(" ");
        chart.append(svg("path", { class: `line ${series.slot}`, d }));
      }
      const last = runs.at(-1)?.at(-1);
      if (last !== undefined) {
        chart.append(
          svg("circle", { class: `end ${series.slot}`, cx: x(last.time), cy: y(last.value), r: 4 }),
        );
      }
    }
    const active = this.#activeIndex(visible);
    if (active !== null) {
      const point = visible[active] as DevicePoint;
      chart.append(
        svg("line", {
          class: "crosshair",
          x1: x(point.time),
          x2: x(point.time),
          y1: PAD.top,
          y2: PAD.top + plotHeight,
        }),
      );
      for (const series of SERIES) {
        const value = point[series.key];
        if (value === null) continue;
        chart.append(
          svg("circle", { class: `end ${series.slot}`, cx: x(point.time), cy: y(value), r: 4 }),
        );
      }
      this.#showTip(point, x(point.time), width);
    } else {
      this.#tip.hidden = true;
    }
    replace(this.#plot, chart);
  }

  #activeIndex(visible: readonly DevicePoint[]): number | null {
    if (this.#activeTime === null || visible.length === 0) return null;
    const index = visible.findIndex((point) => point.time === this.#activeTime);
    if (index >= 0) return index;
    // The point that the crosshair marked left the 2 minutes.
    this.#activeTime = null;
    return null;
  }

  #showTip(point: DevicePoint, left: number, width: number): void {
    replace(
      this.#tip,
      el("div", { class: "tip-time" }, formatTime(point.time, this.#now)),
      ...SERIES.map((series) =>
        el(
          "div",
          { class: "tip-row" },
          el("span", { class: `key ${series.slot}`, attrs: { "aria-hidden": "true" } }),
          el("strong", null, formatRate(point[series.key])),
          el("span", { class: "tip-label" }, series.label),
        ),
      ),
      el(
        "div",
        { class: "tip-row" },
        el("span", { class: "key none", attrs: { "aria-hidden": "true" } }),
        el("strong", null, formatRate(point.errors)),
        el("span", { class: "tip-label" }, "failed"),
      ),
    );
    this.#tip.hidden = false;
    // The tooltip sits beside the crosshair, on the side with room.
    const onLeft = left > width * 0.6;
    this.#tip.style.left = onLeft ? "" : `${left + 12}px`;
    this.#tip.style.right = onLeft ? `${width - left + 12}px` : "";
  }

  #point(clientX: number): void {
    const visible = this.#visible();
    if (visible.length === 0) return;
    const box = this.#plot.getBoundingClientRect();
    const width = box.width || 480;
    const plotWidth = width - PAD.left - PAD.right;
    const time =
      this.#now - CHART_SPAN_MS + ((clientX - box.left - PAD.left) / plotWidth) * CHART_SPAN_MS;
    const index = nearestIndex(
      visible.map((point) => point.time),
      time,
    );
    const point = visible[index];
    if (point === undefined || point.time === this.#activeTime) return;
    this.#activeTime = point.time;
    this.#draw();
  }

  /** Moves the crosshair by `by` points; 0 marks the newest when none is marked. */
  #step(by: number): void {
    const visible = this.#visible();
    if (visible.length === 0) return;
    const current = this.#activeIndex(visible);
    const index =
      current === null
        ? visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, current + by));
    this.#activeTime = (visible[index] as DevicePoint).time;
    this.#draw();
  }

  #key(event: KeyboardEvent): void {
    const visible = this.#visible();
    const moves: Record<string, () => void> = {
      ArrowLeft: () => this.#step(-1),
      ArrowRight: () => this.#step(1),
      Home: () => this.#step(-visible.length),
      End: () => this.#step(visible.length),
      Escape: () => this.#hide(),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }

  #hide(): void {
    if (this.#activeTime === null) return;
    this.#activeTime = null;
    this.#draw();
  }

  #drawLegend(): void {
    const newest = this.#visible().at(-1);
    replace(
      this.#legend,
      ...SERIES.map((series) =>
        el(
          "span",
          { class: "legend-item" },
          el("span", { class: `key ${series.slot}`, attrs: { "aria-hidden": "true" } }),
          el("span", null, series.label),
          el("strong", null, newest === undefined ? MISSING : formatRate(newest[series.key])),
        ),
      ),
    );
  }

  #drawTable(): void {
    const key = `${this.#points.length}:${this.#points.at(-1)?.time ?? 0}:${this.#points[0]?.time ?? 0}`;
    if (key === this.#tableKey) return;
    this.#tableKey = key;
    replace(
      this.#rows,
      ...[...this.#points]
        .reverse()
        .map((point) =>
          el(
            "tr",
            null,
            el("td", { class: "mono" }, formatTime(point.time, this.#now)),
            el("td", { class: "num" }, formatRate(point.served)),
            el("td", { class: "num" }, formatRate(point.made)),
            el("td", { class: "num" }, formatRate(point.errors)),
          ),
        ),
    );
    if (this.#points.length === 0) {
      this.#rows.append(el("tr", null, el("td", { attrs: { colspan: "4" } }, "No readings yet.")));
    }
  }
}
