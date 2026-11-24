/**
 * The page's tables: the history, newest first; the calls from outside the rack, per address and
 * member; and a device's counters, per member of its ports and needs. Every cell holds text.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 */
import type {
  CalledRpcMetrics,
  DeviceMetrics,
  ServedRpcMetrics,
  StreamMetrics,
} from "../../metrics.ts";
import type { UpdateRecord } from "../../reports.ts";
import { type Child, el, reconcile } from "./dom.ts";
import {
  formatBytes,
  formatCount,
  formatErrorCodes,
  formatMean,
  formatRate,
  formatTime,
  MISSING,
  shortHash,
  visibleText,
} from "./format.ts";
import { icon } from "./icons.ts";
import type { DeviceRates, MemberCounters, MemberRates, OutsideTrack } from "./rates.ts";

/** A column of a table: its heading, and whether it holds numbers, which align to the right. */
type Column = [heading: string, kind?: "num"];

/**
 * Makes a table in a wrapper that scrolls sideways on a narrow screen.
 *
 * @param columns The columns.
 * @param body The table's body.
 * @param caption What the table holds, for screen readers and as its title.
 * @returns The wrapper.
 */
export function tableOf(
  columns: readonly Column[],
  body: HTMLTableSectionElement,
  caption?: string,
): HTMLDivElement {
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      null,
      caption === undefined ? null : el("caption", null, caption),
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          ...columns.map(([heading, kind]) =>
            el("th", { attrs: { scope: "col" }, class: kind === "num" ? "num" : "" }, heading),
          ),
        ),
      ),
      body,
    ),
  );
}

/**
 * A firmware hash as the page shows it: short, with the whole hash in its tooltip.
 *
 * @param hash The hash, or `null`.
 */
export function hashCell(hash: string | null | undefined): HTMLElement {
  return el("span", { class: "mono hash", title: hash ?? "" }, shortHash(hash));
}

/** The history's records, newest first, or the ones of one device. */
export class HistoryTable {
  /** The table's element. */
  readonly root: HTMLElement;
  readonly #body: HTMLTableSectionElement;
  readonly #empty: HTMLParagraphElement;
  readonly #withDevice: boolean;

  /**
   * @param withDevice Whether a column names each record's device; the history of one device
   *   needs none.
   * @param emptyText What the table says when it has no records.
   */
  constructor(withDevice: boolean, emptyText: string) {
    this.#withDevice = withDevice;
    this.#body = el("tbody");
    this.#empty = el("p", { class: "empty-note" }, emptyText);
    const columns: Column[] = [["#", "num"], ["Time"]];
    if (withDevice) columns.push(["Device"]);
    columns.push(["Cause"], ["Mode"], ["Firmware"], ["Outcome"]);
    this.root = el("div", { class: "history-table" }, tableOf(columns, this.#body), this.#empty);
  }

  /**
   * Shows records.
   *
   * @param records The records, newest first.
   * @param now The current time, a millisecond timestamp.
   */
  update(records: readonly UpdateRecord[], now: number): void {
    this.#empty.hidden = records.length > 0;
    reconcile(
      this.#body,
      records.map((record) => {
        const time = formatTime(record.time, now);
        return {
          id: String(record.seq),
          key: `${JSON.stringify(record)}|${time}`,
          build: () => this.#row(record, time),
        };
      }),
    );
  }

  #row(record: UpdateRecord, time: string): HTMLTableRowElement {
    const cause =
      record.group === undefined ? record.cause : `${record.cause}, group #${record.group}`;
    return el(
      "tr",
      { class: record.ok ? "" : "failed", attrs: { "data-seq": String(record.seq) } },
      el("td", { class: "num mono" }, String(record.seq)),
      el("td", { class: "mono" }, time),
      this.#withDevice ? el("td", { class: "strong" }, record.device) : null,
      el("td", null, cause),
      el("td", null, record.mode),
      el("td", null, hashCell(record.from), " → ", hashCell(record.to)),
      el(
        "td",
        null,
        el(
          "span",
          { class: "outcome" },
          icon(record.ok ? "ok" : "failed"),
          record.ok ? "ok" : "failed",
        ),
        record.error === undefined
          ? null
          : el(
              "div",
              { class: "error-text" },
              el("span", { class: "mono" }, visibleText(record.error.code)),
              `: ${visibleText(record.error.message)}`,
            ),
      ),
    );
  }
}

/** What a member's counters say about the calls in progress: active, or pending and queued. */
function nowText(counters: ServedRpcMetrics | CalledRpcMetrics): string {
  return "active" in counters
    ? `${formatCount(counters.active)} active`
    : `${formatCount(counters.pending)} pending, ${formatCount(counters.queued)} queued`;
}

/** The streams of a member's calls, as people read them. */
function streamsText(streams: StreamMetrics | undefined): Child {
  if (streams === undefined) return MISSING;
  const errors = formatErrorCodes(streams.errors);
  return el(
    "span",
    null,
    `${formatCount(streams.open)} open of ${formatCount(streams.opened)}, ${formatBytes(streams.bytesSent)} sent, ${formatBytes(streams.bytesReceived)} received`,
    errors === "" ? null : el("span", { class: "error-text" }, `, failed: ${errors}`),
  );
}

/** What a member's counters add up to since its instance started. */
function totalsText(counters: ServedRpcMetrics | CalledRpcMetrics): Child {
  const errors = formatErrorCodes(counters.errors);
  return el(
    "span",
    null,
    `${formatCount(counters.calls)} calls, ${formatCount(counters.ok)} ok`,
    errors === "" ? null : el("span", { class: "error-text" }, `; failed: ${errors}`),
  );
}

/** The calls from outside the rack, per address and member, and the ones that reached no port. */
export class OutsideTable {
  /** The table's element. */
  readonly root: HTMLElement;
  readonly #body: HTMLTableSectionElement;
  readonly #unrouted: HTMLParagraphElement;
  readonly #empty: HTMLParagraphElement;

  constructor() {
    this.#body = el("tbody");
    this.#unrouted = el("p", { class: "note" });
    this.#empty = el("p", { class: "empty-note" }, "No call from outside the rack yet.");
    this.root = el(
      "div",
      null,
      tableOf(
        [
          ["Address"],
          ["Member"],
          ["Calls/s", "num"],
          ["Failed/s", "num"],
          ["Mean", "num"],
          ["Now"],
          ["Since the rack started"],
        ],
        this.#body,
      ),
      this.#empty,
      this.#unrouted,
    );
  }

  /**
   * Shows the last reading.
   *
   * @param outside The readings of the calls from outside.
   */
  update(outside: OutsideTrack): void {
    this.#empty.hidden = outside.rows.length > 0;
    reconcile(
      this.#body,
      outside.rows.map((row) => ({
        id: `${row.address}\n${row.member}`,
        key: JSON.stringify([row.rates, row.counters]),
        build: () =>
          el(
            "tr",
            null,
            el("td", { class: "mono" }, row.address),
            el("td", { class: "mono" }, row.member),
            el("td", { class: "num" }, formatRate(row.rates.rate)),
            el("td", { class: "num" }, formatRate(row.rates.errors)),
            el("td", { class: "num" }, formatMean(row.rates.meanMs)),
            el("td", null, nowText(row.counters)),
            el("td", null, totalsText(row.counters)),
          ),
      })),
    );
    const unrouted = outside.unrouted;
    this.#unrouted.textContent =
      unrouted === null
        ? "Calls that reached no port: no reading yet."
        : `Calls that reached no port, to an address or member that doesn't exist: ${formatCount(unrouted.count)} since the rack started, ${formatRate(unrouted.rate)}.`;
  }
}

/** The kind of a member, as its row names it. */
function kindText(side: "provides" | "needs", kind: "rpc" | "event"): string {
  if (kind === "rpc") return side === "provides" ? "calls served" : "calls made";
  return side === "provides" ? "events emitted" : "events received";
}

/**
 * A device's counters: one table per port it provides and per need, with a row per member.
 *
 * @param counters The device's last reading.
 * @param rates The rates over the interval that the reading ended.
 * @returns The tables, or a note when the device has no ports and no needs.
 */
export function counterTables(counters: DeviceMetrics, rates: DeviceRates | null): HTMLElement[] {
  const tables: HTMLElement[] = [];
  for (const side of ["provides", "needs"] as const) {
    const ports: Record<string, Record<string, MemberCounters>> = counters[side];
    for (const [port, members] of Object.entries(ports)) {
      const body = el("tbody");
      for (const [member, counter] of Object.entries(members)) {
        const rate: MemberRates | undefined = rates?.[side][port]?.[member];
        const cells: Child[] =
          counter.kind === "rpc"
            ? [
                el("td", { class: "num" }, formatRate(rate?.rate ?? null)),
                el("td", { class: "num" }, formatRate(rate?.errors ?? null)),
                el("td", { class: "num" }, formatMean(rate?.meanMs ?? null)),
                el("td", null, nowText(counter)),
                el("td", null, totalsText(counter)),
                el("td", null, streamsText(counter.streams)),
              ]
            : [
                el("td", { class: "num" }, formatRate(rate?.rate ?? null)),
                el(
                  "td",
                  { class: "num" },
                  "emitted" in counter ? formatRate(rate?.errors ?? null) : MISSING,
                ),
                el("td", { class: "num" }, MISSING),
                el("td", null, MISSING),
                el(
                  "td",
                  null,
                  "emitted" in counter
                    ? `${formatCount(counter.emitted)} emitted, ${formatCount(counter.dropped)} dropped`
                    : `${formatCount(counter.received)} received`,
                ),
                el("td", null, MISSING),
              ];
        body.append(
          el(
            "tr",
            null,
            el("td", { class: "mono" }, member),
            el("td", null, kindText(side, counter.kind)),
            ...cells,
          ),
        );
      }
      tables.push(
        tableOf(
          [
            ["Member"],
            ["Kind"],
            ["Per second", "num"],
            ["Failed or dropped/s", "num"],
            ["Mean", "num"],
            ["Now"],
            ["Since the instance started"],
            ["Streams"],
          ],
          body,
          side === "provides" ? `Port ${port}` : `Need ${port}`,
        ),
      );
    }
  }
  if (tables.length === 0) {
    tables.push(el("p", { class: "empty-note" }, "The device has no ports and no needs."));
  }
  return tables;
}
