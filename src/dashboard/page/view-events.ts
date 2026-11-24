/**
 * The events: the records of the rack's feed that the page holds, newest first, which the operator
 * narrows to a level and a device, with a note of how many dropped out before the page read them.
 * Every record shows as text, markup and control characters included.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
 */
import type { EventRecord } from "../../reports.ts";
import { el, reconcile, replace } from "./dom.ts";
import {
  describeRecord,
  type Feed,
  type FeedFilter,
  filterRecords,
  type Level,
  levelOf,
} from "./feed.ts";
import { formatCount, formatTime } from "./format.ts";
import { icon } from "./icons.ts";

const ALL = "*";
const RACK = "";

/** The events, with the controls that narrow them. */
export class EventsView {
  /** The events' element. */
  readonly root: HTMLElement;
  readonly #level: HTMLSelectElement;
  readonly #device: HTMLSelectElement;
  readonly #note: HTMLParagraphElement;
  readonly #list: HTMLOListElement;
  readonly #empty: HTMLParagraphElement;
  #devicesKey: string | null = null;
  #key = "";
  #feed: Feed | null = null;
  #devices: readonly string[] = [];
  #now = 0;
  /** The device filter's value, which stays across new options. */
  #choice = ALL;

  constructor() {
    this.#level = el(
      "select",
      { attrs: { "data-filter": "level" } },
      el("option", { attrs: { value: ALL } }, "every level"),
      el("option", { attrs: { value: "info" } }, "info"),
      el("option", { attrs: { value: "warn" } }, "warn"),
      el("option", { attrs: { value: "error" } }, "error"),
    );
    this.#device = el("select", { attrs: { "data-filter": "device" } });
    this.#note = el("p", { class: "note", attrs: { "aria-live": "polite" } });
    this.#list = el("ol", { class: "event-list" });
    this.#empty = el("p", { class: "empty-note" });
    const redraw = () => {
      this.#choice = this.#device.value;
      this.#key = "";
      if (this.#feed !== null) this.update(this.#feed, this.#devices, this.#now);
    };
    this.#level.addEventListener("change", redraw);
    this.#device.addEventListener("change", redraw);
    this.root = el(
      "div",
      { class: "events-view" },
      el(
        "div",
        { class: "filters" },
        el("label", null, "Level ", this.#level),
        el("label", null, "Device ", this.#device),
      ),
      this.#note,
      this.#list,
      this.#empty,
    );
  }

  /** The filter that the controls set. */
  get filter(): FeedFilter {
    const level = this.#level.value;
    const device = this.#device.value;
    return {
      level: level === ALL ? null : (level as Level),
      device: device === ALL ? null : device,
    };
  }

  /**
   * Draws the events again when the records or the filter changed.
   *
   * @param feed The records that the page holds.
   * @param devices The names of the devices that `status()` reports, for the device filter.
   * @param now The current time, a millisecond timestamp.
   */
  update(feed: Feed, devices: readonly string[], now: number): void {
    this.#feed = feed;
    this.#devices = devices;
    this.#now = now;
    this.#updateDevices(feed, devices);
    const filter = this.filter;
    const day = new Date(now).toDateString();
    const key = `${feed.version}|${filter.level}|${filter.device}|${day}`;
    if (key === this.#key) return;
    this.#key = key;
    const shown = filterRecords(feed.records, filter);
    reconcile(
      this.#list,
      shown.map((record) => ({
        // A rack that started again numbers its records from 1 anew.
        id: `${feed.epoch}:${record.seq}`,
        key: day,
        build: () => this.#row(record, now),
      })),
    );
    const parts = [
      shown.length === feed.records.length
        ? `${formatCount(feed.records.length)} records, newest first; the page keeps the newest 1,000.`
        : `${formatCount(shown.length)} of ${formatCount(feed.records.length)} records, newest first.`,
    ];
    if (feed.dropped > 0) {
      parts.push(
        `${formatCount(feed.dropped)} ${feed.dropped === 1 ? "record" : "records"} dropped out of the rack's feed before the page read them.`,
      );
    }
    if (feed.restartedAt !== null) {
      parts.push(
        `The rack started again at ${formatTime(feed.restartedAt, now)}; its feed starts anew.`,
      );
    }
    this.#note.textContent = parts.join(" ");
    this.#empty.hidden = shown.length > 0;
    this.#empty.textContent =
      feed.records.length === 0 ? "No records yet." : "No record matches the level and the device.";
  }

  /** Keeps the device filter's options: every device of the rack and of the records. */
  #updateDevices(feed: Feed, devices: readonly string[]): void {
    const names = new Set(devices);
    for (const record of feed.records) if (record.device !== undefined) names.add(record.device);
    const sorted = [...names].sort();
    const key = sorted.join("\n");
    if (key === this.#devicesKey) return;
    this.#devicesKey = key;
    const chosen = this.#choice;
    replace(
      this.#device,
      el("option", { attrs: { value: ALL } }, "every device"),
      el("option", { attrs: { value: RACK } }, "the rack itself"),
      ...sorted.map((name) => el("option", { attrs: { value: name } }, name)),
    );
    // A device chosen before stays chosen, even once the rack no longer reports it.
    if (chosen !== ALL && chosen !== RACK && !names.has(chosen)) {
      this.#device.append(el("option", { attrs: { value: chosen } }, chosen));
    }
    this.#device.value = chosen;
  }

  #row(record: EventRecord, now: number): HTMLLIElement {
    const level = levelOf(record);
    const text = describeRecord(record);
    return el(
      "li",
      {
        class: `event level-${level}`,
        attrs: { "data-seq": String(record.seq), "data-type": record.type },
      },
      el(
        "span",
        { class: "event-time mono", title: `#${record.seq}` },
        formatTime(record.time, now),
      ),
      el("span", { class: "event-level" }, icon(level), level),
      record.device === undefined
        ? el(
            "span",
            { class: "event-device rack-self", title: "An entry that the rack wrote itself" },
            "rack",
          )
        : el("span", { class: "event-device" }, record.device),
      el(
        "span",
        { class: "event-text" },
        el("span", { class: "event-type" }, record.type),
        el("span", { class: "event-summary" }, text.summary),
        record.cut === true
          ? el(
              "span",
              {
                class: "mark cut",
                title:
                  "Longer than 4,096 characters as JSON: the rack dropped its data and cut its messages",
              },
              "cut",
            )
          : null,
        text.error === null ? null : el("span", { class: "error-text" }, text.error),
        text.data === null ? null : el("code", { class: "data" }, text.data),
      ),
    );
  }
}
