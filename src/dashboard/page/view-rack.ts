/**
 * The rack's front: its units from the top down, each device a block as tall as the units it
 * takes, with its name, its state as a word and an icon besides a color, and marks for a hot-plug
 * device, a copy for an `own` need, and firmware packaged in an executable. Empty units show.
 * Selecting a device shows its details.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 */
import type { SlotStatus } from "../../reports.ts";
import { el, replace } from "./dom.ts";
import { marksOf, shortHash, unitsText } from "./format.ts";
import { emptyUnits, placeOf, unitsOf } from "./geometry.ts";
import { icon } from "./icons.ts";

/** The rack's front, drawn again when a device, its state, or the selection changes. */
export class RackView {
  /** The front's element. */
  readonly root: HTMLElement;
  readonly #grid: HTMLDivElement;
  readonly #size: HTMLSpanElement;
  readonly #onSelect: (name: string) => void;
  #key = "";
  /** Whether the front has scrolled to its highest device once. */
  #placed = false;

  /** @param onSelect Called with a device's name when the operator selects it. */
  constructor(onSelect: (name: string) => void) {
    this.#onSelect = onSelect;
    this.#grid = el("div", { class: "rack-grid" });
    this.#size = el("span", { class: "mono" });
    this.root = el(
      "div",
      { class: "rack" },
      el("div", { class: "rack-title" }, el("span", null, "front of the rack"), this.#size),
      this.#grid,
    );
  }

  /**
   * Draws the front again when what it shows changed.
   *
   * @param devices The devices, as `status()` reports them; `null` before it answered.
   * @param selected The selected device, or `null`.
   */
  update(devices: readonly SlotStatus[] | null, selected: string | null): void {
    const list = devices ?? [];
    const units = unitsOf(list);
    const key = JSON.stringify([
      units,
      selected,
      list.map((device) => [
        device.name,
        device.u,
        device.height,
        device.state,
        device.model,
        device.firmware,
        device.hotplug,
        device.owner,
        device.packaged,
      ]),
    ]);
    if (key === this.#key) return;
    this.#key = key;
    // A device that had the focus keeps it across the new drawing.
    const focused = document.activeElement;
    const focusedName =
      focused instanceof HTMLElement && this.#grid.contains(focused)
        ? (focused.dataset.device ?? null)
        : null;
    this.#size.textContent = `${units}U`;
    // The grid's rows follow the rack's size, which the page knows only from status().
    this.#grid.style.gridTemplateRows = `repeat(${units}, var(--unit-height))`;
    const children: HTMLElement[] = [];
    for (let unit = units; unit >= 1; unit--) {
      const label = el(
        "span",
        { class: "u-label mono", attrs: { "aria-hidden": "true" } },
        `U${unit}`,
      );
      label.style.gridRow = String(units - unit + 1);
      children.push(label);
    }
    for (const unit of emptyUnits(list, units)) {
      const slot = el("div", { class: "slot empty", title: `U${unit} is empty` });
      slot.style.gridRow = String(units - unit + 1);
      children.push(slot);
    }
    // Blocks follow the front from the top down, so that the keyboard reaches them in that order.
    const topDown = [...list].sort((a, b) => b.u + b.height - (a.u + a.height));
    for (const device of topDown) {
      children.push(this.#block(device, units, device.name === selected));
    }
    const scrolled = this.#grid.scrollTop;
    replace(this.#grid, ...children);
    const top = this.#grid.querySelector<HTMLElement>("[data-device]");
    if (!this.#placed && top !== null) {
      // A front taller than the screen first shows its highest device; devices sit low in a rack.
      this.#placed = true;
      this.#grid.scrollTop = Math.max(0, top.offsetTop - 2 * top.offsetHeight);
    } else {
      this.#grid.scrollTop = scrolled;
    }
    if (focusedName !== null) {
      const again = [...this.#grid.querySelectorAll<HTMLElement>("[data-device]")].find(
        (element) => element.dataset.device === focusedName,
      );
      again?.focus();
    }
  }

  #block(device: SlotStatus, units: number, selected: boolean): HTMLButtonElement {
    const place = placeOf(device, units);
    const marks = marksOf(device);
    const tall = device.height > 1;
    const block = el(
      "button",
      {
        class: `device state-${device.state}${tall ? " tall" : ""}${selected ? " selected" : ""}`,
        title: `${device.name}, ${unitsText(device)}: ${device.state}`,
        attrs: {
          type: "button",
          "data-device": device.name,
          "data-state": device.state,
          "aria-pressed": selected ? "true" : "false",
          "aria-label": `${device.name}, ${unitsText(device)}, ${device.state}${marks.map((mark) => `, ${mark.text}`).join("")}`,
        },
      },
      icon(device.state),
      el(
        "span",
        { class: "device-text" },
        el(
          "span",
          { class: "device-line" },
          el("span", { class: "device-name" }, device.name),
          el("span", { class: "device-state" }, device.state),
        ),
        tall
          ? el(
              "span",
              { class: "device-sub" },
              `${device.model} · `,
              el("span", { class: "mono" }, shortHash(device.firmware)),
            )
          : null,
      ),
      marks.length === 0
        ? null
        : el(
            "span",
            { class: "device-marks" },
            ...marks.map((mark) =>
              el("span", { class: `mark ${mark.kind}`, title: mark.title }, mark.short),
            ),
          ),
    );
    block.style.gridRow = `${place.row} / span ${place.rows}`;
    block.addEventListener("click", () => this.#onSelect(device.name));
    return block;
  }
}
