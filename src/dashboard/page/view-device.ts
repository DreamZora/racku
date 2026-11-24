/**
 * A device's details: everything `status()` reports for it; its counters per member of its ports
 * and needs; its event loop's delay, and a chart of its calls per second over the last 2 minutes;
 * its updates in the history; and the operations that act on it.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#operations-from-the-page
 */
import type { SlotStatus } from "../../reports.ts";
import { button, type Child, el, reconcile, replace } from "./dom.ts";
import {
  formatAge,
  formatCount,
  formatData,
  formatDuration,
  formatMean,
  formatTime,
  formatWhen,
  marksOf,
  shortHash,
  unitsText,
  visibleText,
} from "./format.ts";
import { icon } from "./icons.ts";
import type { Model } from "./model.ts";
import { rollbackTargets } from "./operations.ts";
import { LATE_READING_MS } from "./rates.ts";
import { ChartView } from "./view-chart.ts";
import { counterTables, HistoryTable, hashCell, tableOf } from "./view-tables.ts";

/** What the buttons of a device's details do; each opens the dialog that asks first. */
export interface DeviceActions {
  swap(device: SlotStatus): void;
  restart(device: SlotStatus): void;
  rollback(device: SlotStatus): void;
}

/** The details of the selected device. */
export class DeviceView {
  /** The details' element. */
  readonly root: HTMLElement;
  readonly #actions: DeviceActions;
  readonly #placeholder: HTMLParagraphElement;
  readonly #body: HTMLDivElement;
  readonly #head: HTMLDivElement;
  readonly #fields: HTMLDListElement;
  readonly #parts: HTMLDivElement;
  readonly #loop: HTMLParagraphElement;
  readonly #chartHolder: HTMLDivElement;
  readonly #countersNote: HTMLParagraphElement;
  readonly #counters: HTMLDivElement;
  readonly #updates: HistoryTable;
  #name: string | null = null;
  #chart: ChartView | null = null;
  #headKey = "";
  #countersKey = "";

  /** @param actions What the operation buttons do. */
  constructor(actions: DeviceActions) {
    this.#actions = actions;
    this.#placeholder = el("p", { class: "placeholder" });
    this.#head = el("div", { class: "device-head" });
    this.#fields = el("dl", { class: "fields" });
    this.#parts = el("div", { class: "parts" });
    this.#loop = el("p", { class: "loop" });
    this.#chartHolder = el("div");
    this.#countersNote = el("p", { class: "note" });
    this.#counters = el("div", { class: "counters" });
    this.#updates = new HistoryTable(false, "The history lists no update of this device.");
    this.#body = el(
      "div",
      { class: "device-body" },
      this.#head,
      this.#fields,
      this.#parts,
      el("h3", null, "Event loop"),
      this.#loop,
      el("h3", null, "Calls per second, the last 2 minutes"),
      this.#chartHolder,
      el("h3", null, "Counters"),
      this.#countersNote,
      this.#counters,
      el("h3", null, "Updates"),
      this.#updates.root,
    );
    this.root = el("div", { class: "device-view" }, this.#placeholder, this.#body);
  }

  /**
   * Draws the details again.
   *
   * @param model What the page knows of the rack.
   * @param selected The selected device, or `null`.
   * @param now The current time, a millisecond timestamp.
   * @param canOperate Whether the operation buttons work: the rack answers, and no operation runs.
   */
  update(model: Model, selected: string | null, now: number, canOperate: boolean): void {
    const device = selected === null ? undefined : model.device(selected);
    if (device === undefined) {
      this.#placeholder.textContent =
        selected === null
          ? "Select a device on the rack's front to see its details and to operate it."
          : `The rack doesn't report a device named ${selected} now.`;
      this.#placeholder.hidden = false;
      this.#body.hidden = true;
      return;
    }
    this.#placeholder.hidden = true;
    this.#body.hidden = false;
    if (this.#name !== device.name) {
      this.#name = device.name;
      this.#chart = new ChartView(device.name);
      replace(this.#chartHolder, this.#chart.root);
      this.#headKey = "";
      this.#countersKey = "";
    }
    this.#drawHead(device, model, canOperate);
    this.#drawFields(device, now);
    this.#drawParts(device, now);
    this.#drawCounters(device, model, now);
    this.#updates.update(
      (model.history ?? []).filter((record) => record.device === device.name),
      now,
    );
  }

  #drawHead(device: SlotStatus, model: Model, canOperate: boolean): void {
    const canRollBack = rollbackTargets(device, model.history ?? []).length > 0;
    const key = JSON.stringify([
      device.name,
      device.state,
      device.hotplug,
      device.owner,
      device.packaged,
      canOperate,
      canRollBack,
    ]);
    if (key === this.#headKey) return;
    this.#headKey = key;
    const name = device.name;
    // A button acts on the device as the rack reports it when it is pressed, not when drawn.
    const act = (action: (current: SlotStatus) => void) => () => {
      const current = model.device(name);
      if (current !== undefined) action(current);
    };
    const operate = (label: string, op: string, run: () => void, enabled: boolean, why: string) => {
      const element = button(label, run, { class: "op", attrs: { "data-op": op } });
      element.disabled = !enabled;
      if (!enabled) element.title = why;
      return element;
    };
    const busy = "The rack doesn't answer, or an operation runs";
    replace(
      this.#head,
      el(
        "h2",
        { class: "device-title" },
        icon(device.state),
        el("span", { class: "name" }, device.name),
        el("span", { class: `state-word state-${device.state}` }, device.state),
      ),
      el(
        "div",
        { class: "device-marks" },
        ...marksOf(device).map((mark) =>
          el("span", { class: `mark ${mark.kind}`, title: mark.title }, mark.text),
        ),
      ),
      el(
        "div",
        { class: "ops" },
        operate(
          "Swap…",
          "swap",
          act((current) => this.#actions.swap(current)),
          canOperate,
          busy,
        ),
        operate(
          "Restart…",
          "restart",
          act((current) => this.#actions.restart(current)),
          canOperate,
          busy,
        ),
        operate(
          "Roll back…",
          "rollback",
          act((current) => this.#actions.rollback(current)),
          canOperate && canRollBack,
          canRollBack ? busy : "No other firmware is known-good or in the history",
        ),
      ),
    );
  }

  #drawFields(device: SlotStatus, now: number): void {
    const knownGood: Child[] =
      device.knownGood === null
        ? ["none"]
        : [
            hashCell(device.knownGood),
            device.knownGood === device.firmware ? ", the firmware it runs" : null,
          ];
    const error = device.error;
    const fields: Array<[id: string, label: string, value: Child[], key: string]> = [
      ["state", "State", [icon(device.state), ` ${device.state}`], device.state],
      ["model", "Model", [device.model], device.model],
      ["slot", "Slot", [`${unitsText(device)}, ${device.height}U`], `${device.u}:${device.height}`],
      [
        "firmware",
        "Firmware",
        [
          device.firmware === null ? "none installed" : hashCell(device.firmware),
          device.packaged === true ? ", packaged in the executable" : null,
        ],
        `${device.firmware}:${device.packaged}`,
      ],
      ["knownGood", "Known-good firmware", knownGood, `${device.knownGood}:${device.firmware}`],
      [
        "probation",
        "Probation",
        [
          device.probationUntil === undefined
            ? "none"
            : `until ${formatWhen(device.probationUntil, now)}`,
        ],
        device.probationUntil === undefined ? "none" : formatWhen(device.probationUntil, now),
      ],
      ["source", "Source", [el("span", { class: "mono path" }, device.source)], device.source],
      ["inFlight", "Calls in flight", [formatCount(device.inFlight)], String(device.inFlight)],
      [
        "crashes",
        "Crashes in the crash window",
        [formatCount(device.crashes)],
        String(device.crashes),
      ],
      [
        "hotplug",
        "Hot-plug",
        [device.hotplug === true ? "yes, from a hot-plug directory" : "no"],
        String(device.hotplug),
      ],
      [
        "owner",
        "Copy for an own need",
        [device.owner === undefined ? "no" : `yes, of ${device.owner}`],
        String(device.owner),
      ],
      [
        "error",
        "Last error",
        error === undefined
          ? ["none"]
          : [
              el(
                "span",
                { class: "error-text" },
                el("span", { class: "mono" }, visibleText(error.code)),
                `: ${visibleText(error.message)}`,
              ),
              error.data === undefined
                ? null
                : el("pre", { class: "data" }, formatData(error.data)),
            ],
        JSON.stringify(error ?? null),
      ],
    ];
    reconcile(
      this.#fields,
      fields.map(([id, label, value, key]) => ({
        id,
        key,
        build: () =>
          el(
            "div",
            { class: "field", attrs: { "data-field": id } },
            el("dt", null, label),
            el("dd", null, ...value),
          ),
      })),
    );
  }

  #drawParts(device: SlotStatus, now: number): void {
    const parts: Array<{ id: string; key: string; build: () => Element }> = [];
    const watchdogs = device.watchdogs.map((watchdog) => [
      watchdog.name,
      formatDuration(watchdog.timeout),
      formatWhen(watchdog.lastFed, now),
    ]);
    parts.push({
      id: "watchdogs",
      key: JSON.stringify(watchdogs),
      build: () =>
        section(
          "Watchdogs",
          watchdogs.length === 0
            ? el(
                "p",
                { class: "empty-note" },
                "None: watchdogs are off, or no instance is installed.",
              )
            : tableOf(
                [["Name"], ["Timeout", "num"], ["Last fed"]],
                el(
                  "tbody",
                  null,
                  ...watchdogs.map(([name, timeout, fed]) =>
                    el(
                      "tr",
                      null,
                      el("td", { class: "mono" }, name),
                      el("td", { class: "num" }, timeout),
                      el("td", null, fed),
                    ),
                  ),
                ),
              ),
        ),
    });
    const listeners = device.listeners.map((listener) => ({
      url: listener.url,
      requests: formatCount(listener.requests),
      webSockets: formatCount(listener.webSockets),
      certificates:
        listener.certificates.length === 0
          ? "none, without TLS"
          : listener.certificates
              .map(
                (certificate) =>
                  `${certificate.subject}${certificate.serverName === undefined ? "" : ` for ${certificate.serverName}`}, expires ${formatWhen(certificate.notAfter, now)}`,
              )
              .join("; "),
    }));
    parts.push({
      id: "listeners",
      key: JSON.stringify(listeners),
      build: () =>
        section(
          "Listeners",
          listeners.length === 0
            ? el("p", { class: "empty-note" }, "None.")
            : tableOf(
                [["URL"], ["Requests", "num"], ["WebSockets", "num"], ["Certificates"]],
                el(
                  "tbody",
                  null,
                  ...listeners.map((listener) =>
                    el(
                      "tr",
                      null,
                      el("td", { class: "mono" }, listener.url),
                      el("td", { class: "num" }, listener.requests),
                      el("td", { class: "num" }, listener.webSockets),
                      el("td", null, listener.certificates),
                    ),
                  ),
                ),
              ),
        ),
    });
    const stuck = device.stuck.map((thread) => ({
      firmware: thread.firmware,
      since: formatWhen(thread.since, now),
      listeners: thread.listeners.map((listener) => listener.url).join(", ") || "none",
    }));
    parts.push({
      id: "stuck",
      key: JSON.stringify(stuck),
      build: () =>
        section(
          "Stuck threads",
          stuck.length === 0
            ? el("p", { class: "empty-note" }, "None.")
            : tableOf(
                [["Firmware"], ["Terminated"], ["Listeners it keeps"]],
                el(
                  "tbody",
                  null,
                  ...stuck.map((thread) =>
                    el(
                      "tr",
                      { class: "failed" },
                      el("td", null, hashCell(thread.firmware)),
                      el("td", null, thread.since),
                      el("td", { class: "mono" }, thread.listeners),
                    ),
                  ),
                ),
              ),
        ),
    });
    reconcile(this.#parts, parts);
  }

  #drawCounters(device: SlotStatus, model: Model, now: number): void {
    const track = model.tracks.get(device.name);
    const counters = track?.counters ?? null;
    const fresh = model.fresh.metrics;
    const key = `${model.versions.metrics}:${device.name}:${Math.floor(now / 1000)}`;
    if (track !== undefined && this.#chart !== null) this.#chart.update(track.points, now);
    else this.#chart?.update([], now);
    if (key === this.#countersKey) return;
    this.#countersKey = key;
    // The rack leaves out a device that doesn't answer metrics() within hookTimeout, and one
    // with no instance: the page shows its last counters as missing.
    // @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
    const missing = counters === null || track?.missing === true;
    this.#counters.classList.toggle("missing", missing);
    this.#loop.classList.toggle("missing", missing);
    if (counters === null || track === undefined) {
      this.#loop.textContent = "Missing: no reading of this device's counters yet.";
      this.#countersNote.textContent =
        fresh.failure === null
          ? "Missing: no reading of this device's counters yet."
          : `Missing: no reading of this device's counters yet; metrics() failed: ${fresh.failure.reason}.`;
      replace(this.#counters);
      return;
    }
    this.#loop.textContent = `Its timer runs ${formatMean(counters.loop.delayMs)} late now, and ran at most ${formatMean(counters.loop.maxDelayMs)} late since the instance booted.`;
    const notes: string[] = [];
    if (track.missing) {
      const readAt = track.readAt ?? now;
      const why =
        fresh.failure === null
          ? "The last answer of metrics() left this device out: it has no instance, or didn't answer in time."
          : `The last read of metrics() failed: ${fresh.failure.reason}.`;
      notes.push(
        `${why} Its counters are missing; these are from ${formatTime(readAt, now)}, ${formatAge(now - readAt)} ago.`,
      );
    }
    const latest = track.latest;
    if (latest?.restarted === true) {
      notes.push(
        "The counters restarted at the last reading, since the instance changed: that interval gives no rate.",
      );
    }
    if (latest?.late === true) {
      notes.push(
        `The rack took more than ${LATE_READING_MS / 1000} s to answer metrics(), at the last reading or the one before, as when it waits for a device that is slow to answer: the page doesn't know when it read these counters, so that interval gives no rate.`,
      );
    }
    // A late reading gives no rate for the next interval either.
    const rates =
      latest === null || latest.seconds === 0 || latest.restarted || latest.late
        ? `Rates come with ${latest?.late === true ? "a later" : "the next"} reading`
        : `Rates over the last ${formatDuration(latest.seconds * 1000)}`;
    notes.push(
      `${rates}; totals since the instance booted, ${formatWhen(counters.since, now)}, with firmware ${shortHash(counters.firmware)}.`,
    );
    this.#countersNote.textContent = notes.join(" ");
    replace(this.#counters, ...counterTables(counters, track.latest));
  }
}

function section(title: string, content: Element): HTMLElement {
  return el("section", { class: "part" }, el("h3", null, title), content);
}
