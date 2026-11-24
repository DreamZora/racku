/**
 * The page: the rack, its front, the selected device, the calls from outside, the history, and the
 * events, drawn from what the page knows of the rack; and the operations, each asked first in a
 * dialog, one at a time. While the rack doesn't answer, the page says since when and why, and
 * dims the last data.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#operations-from-the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
 */
import type { SlotStatus } from "../../reports.ts";
import { type Connection, connectionOf } from "./connection.ts";
import { button, el, replace } from "./dom.ts";
import { formatAge, formatCount, formatRate, formatTime, shortHash } from "./format.ts";
import { icon } from "./icons.ts";
import { type Model, type ReadKind, SLOT_STATES } from "./model.ts";
import {
  type Done,
  describeOutcome,
  type Operation,
  type Operations,
  reloadOperation,
  restartOperation,
  rollbackOperation,
  rollbackTargets,
  stopOperation,
  swapOperation,
} from "./operations.ts";
import { DeviceView } from "./view-device.ts";
import { type Choice, ConfirmDialog } from "./view-dialog.ts";
import { EventsView } from "./view-events.ts";
import { RackView } from "./view-rack.ts";
import { HistoryTable, OutsideTable } from "./view-tables.ts";

/** What the page says while the dashboard refuses it, or before it has a token. */
export type Gate = "no-token" | "unauthorized" | "refused";

/**
 * Shows only a message, and nothing of the rack: the page has no token, or the dashboard refused
 * it.
 *
 * @param root The page's element.
 * @param gate Why.
 */
export function showGate(root: HTMLElement, gate: Gate): void {
  const messages: Record<Gate, string[]> = {
    "no-token": [
      "This page has no token, so it shows nothing of the rack.",
      `Open the URL that rack dashboard printed when it started, with its #token= part, such as ${location.origin}/#token=…`,
    ],
    unauthorized: [
      "The dashboard refused this page's token. The token may be from an earlier start of rack dashboard, which makes a new one each time it starts.",
      "Open the URL that rack dashboard printed when it started, with its #token= part.",
    ],
    refused: [
      "The dashboard refused this page, as it refuses pages of other sites and pages reached through a domain name.",
      "Open the URL that rack dashboard printed, on 127.0.0.1, with its #token= part.",
    ],
  };
  replace(
    root,
    el(
      "div",
      { class: "gate", attrs: { "data-gate": gate, role: "alert" } },
      el("h1", null, el("span", { class: "brand-name" }, "racku"), " dashboard"),
      ...messages[gate].map((text) => el("p", null, text)),
    ),
  );
}

/** The page of a rack, drawn again with each answer, and each second for the ages it shows. */
export class Page {
  readonly #root: HTMLElement;
  readonly #model: Model;
  readonly #operations: Operations;
  readonly #now: () => number;
  readonly #target: HTMLSpanElement;
  readonly #connection: HTMLDivElement;
  readonly #reload: HTMLButtonElement;
  readonly #stop: HTMLButtonElement;
  readonly #banner: HTMLDivElement;
  readonly #tiles: HTMLDivElement;
  readonly #notes: HTMLUListElement;
  readonly #operation: HTMLElement;
  readonly #rack: RackView;
  readonly #device: DeviceView;
  readonly #outside: OutsideTable;
  readonly #history: HistoryTable;
  readonly #events: EventsView;
  readonly #dialog: ConfirmDialog;
  readonly #dimmed: HTMLElement[];
  readonly #details: HTMLElement;
  #selected: string | null = null;
  /** Whether the page shows the message of a refused token or page, in place of the rack. */
  #gated = false;
  #dismissed: Done | null = null;
  #tilesKey = "";
  #operationKey = "";

  /**
   * @param root The page's element, whose children the page replaces.
   * @param model What the page knows of the rack.
   * @param operations Runs the operations.
   * @param now The clock, in milliseconds.
   */
  constructor(root: HTMLElement, model: Model, operations: Operations, now: () => number) {
    this.#root = root;
    this.#model = model;
    this.#operations = operations;
    this.#now = now;
    this.#target = el("span", { class: "target mono", attrs: { "data-target": "" } }, "…");
    this.#connection = el("div", { class: "connection", attrs: { role: "status" } });
    this.#reload = button("Reload…", () => this.#askReload(), {
      class: "op",
      attrs: { "data-op": "reload" },
    });
    this.#stop = button("Stop…", () => this.#askStop(), {
      class: "op danger",
      attrs: { "data-op": "stop" },
    });
    this.#banner = el("div", { class: "banner", attrs: { role: "alert" } });
    this.#tiles = el("div", { class: "tiles" });
    this.#notes = el("ul", { class: "read-notes" });
    this.#operation = el("section", {
      class: "operation",
      attrs: { "aria-live": "polite", "aria-label": "Operation" },
    });
    this.#rack = new RackView((name) => this.#select(name));
    this.#device = new DeviceView({
      swap: (device) => this.#askSwap(device),
      restart: (device) => this.#askRestart(device),
      rollback: (device) => this.#askRollback(device),
    });
    this.#outside = new OutsideTable();
    this.#history = new HistoryTable(true, "The history has no update yet.");
    this.#events = new EventsView();
    this.#dialog = new ConfirmDialog();
    const front = panel("front-panel", "Rack", this.#rack.root);
    const details = panel("details-panel", "Device", this.#device.root);
    this.#details = details;
    const outside = panel("outside-panel", "Calls from outside", this.#outside.root);
    const history = panel("history-panel", "History", this.#history.root);
    const events = panel("events-panel", "Events", this.#events.root);
    this.#dimmed = [this.#tiles, front, details, outside, history, events];
    replace(
      root,
      el(
        "header",
        { class: "top" },
        el(
          "div",
          { class: "brand" },
          el("span", { class: "brand-name" }, "racku"),
          el("span", { class: "brand-sub" }, "dashboard"),
        ),
        el("div", { class: "watching" }, el("span", { class: "label" }, "watching"), this.#target),
        this.#connection,
        el("div", { class: "ops rack-ops" }, this.#reload, this.#stop),
      ),
      this.#banner,
      this.#tiles,
      this.#notes,
      this.#operation,
      el("div", { class: "layout" }, front, details),
      outside,
      history,
      events,
      this.#dialog.root,
    );
  }

  /** The selected device, or `null`. */
  get selected(): string | null {
    return this.#selected;
  }

  /** Draws the page again from what it knows. */
  render(): void {
    const now = this.#now();
    const model = this.#model;
    // A refused token or page ends the polling, whichever request saw it first.
    if (model.final !== null) {
      if (this.#gated) return;
      this.#gated = true;
      this.#dialog.close();
      showGate(this.#root, model.final.status === 403 ? "refused" : "unauthorized");
      return;
    }
    const connection = connectionOf(model.fresh.status, now);
    const live = connection.state === "live";
    const canOperate = live && this.#operations.running === null;
    this.#target.textContent = model.target ?? "…";
    this.#target.title = model.target ?? "";
    this.#drawConnection(connection, now);
    this.#reload.disabled = !canOperate;
    this.#stop.disabled = !canOperate;
    for (const element of this.#dimmed)
      element.classList.toggle("stale", connection.state === "down");
    this.#drawTiles(connection);
    this.#drawNotes(connection, now);
    this.#drawOperation(now);
    this.#rack.update(model.status, this.#selected);
    this.#device.update(model, this.#selected, now, canOperate);
    this.#outside.update(model.outside);
    this.#history.update(model.history ?? [], now);
    this.#events.update(
      model.feed,
      (model.status ?? []).map((device) => device.name),
      now,
    );
  }

  #select(name: string): void {
    this.#selected = this.#selected === name ? null : name;
    this.render();
    // On a narrow screen the details come below the front: they scroll into view.
    if (this.#selected !== null && window.matchMedia("(max-width: 900px)").matches) {
      this.#details.scrollIntoView({ block: "start" });
    }
  }

  #drawConnection(connection: Connection, now: number): void {
    let content: Array<Node | string>;
    switch (connection.state) {
      case "live":
        content = [
          icon("live"),
          el("strong", null, "live"),
          `data ${formatAge(connection.age)} old`,
        ];
        break;
      case "down":
        content = [
          icon("down"),
          el("strong", null, "no answer"),
          `since ${formatTime(connection.since, now)}`,
        ];
        break;
      default:
        content = [icon("waiting"), el("strong", null, "connecting"), "asking the rack…"];
    }
    replace(this.#connection, ...content);
    this.#connection.dataset.state = connection.state;
    if (connection.state === "down") {
      const since = `${formatTime(connection.since, now)}, ${formatAge(now - connection.since)} ago`;
      const data =
        connection.age === null
          ? "The page has no data of the rack yet, and goes on asking every second."
          : `The page shows the last data, from ${formatAge(connection.age)} ago, dimmed, and goes on asking every second.`;
      replace(
        this.#banner,
        icon("down"),
        el(
          "div",
          null,
          el("strong", null, `No answer from the rack since ${since}`),
          el("p", { class: "reason" }, connection.reason),
          el("p", null, data),
        ),
      );
      this.#banner.hidden = false;
    } else {
      this.#banner.hidden = true;
    }
  }

  #drawTiles(connection: Connection): void {
    const model = this.#model;
    const counts = model.counts();
    const total = model.status?.length ?? null;
    const age = "age" in connection ? connection.age : null;
    const outsideRate = model.outside.total;
    const key = JSON.stringify([counts, total, outsideRate, age === null ? null : formatAge(age)]);
    if (key === this.#tilesKey) return;
    this.#tilesKey = key;
    replace(
      this.#tiles,
      tile("devices", "Devices", total === null ? "—" : formatCount(total)),
      ...SLOT_STATES.map((state) =>
        el(
          "div",
          {
            class: `tile state-tile${counts[state] === 0 ? " zero" : ""}`,
            attrs: { "data-state": state },
          },
          el("span", { class: "tile-label" }, icon(state), state),
          el("span", { class: "tile-value" }, formatCount(counts[state])),
        ),
      ),
      tile("outside", "Calls from outside", formatRate(outsideRate)),
      tile("age", "Data", age === null ? "—" : `${formatAge(age)} old`),
    );
  }

  /** Notes the reads other than `status` that fail while the rack answers it. */
  #drawNotes(connection: Connection, now: number): void {
    const notes: HTMLLIElement[] = [];
    if (connection.state === "live") {
      const names: Record<Exclude<ReadKind, "status">, string> = {
        metrics: "The counters",
        history: "The history",
        events: "The events",
        about: "What the dashboard watches",
      };
      for (const [kind, name] of Object.entries(names) as Array<
        [Exclude<ReadKind, "status">, string]
      >) {
        const fresh = this.#model.fresh[kind];
        if (fresh.failingSince === null || fresh.failure === null) continue;
        const age = fresh.age(now);
        notes.push(
          el(
            "li",
            null,
            icon("warn"),
            `${name}: ${fresh.failure.reason}, since ${formatTime(fresh.failingSince, now)}. ${
              age === null ? "No data yet." : `The page shows the data from ${formatAge(age)} ago.`
            }`,
          ),
        );
      }
    }
    replace(this.#notes, ...notes);
    this.#notes.hidden = notes.length === 0;
  }

  #drawOperation(now: number): void {
    const running = this.#operations.running;
    const last = this.#operations.last;
    if (running !== null) {
      const key = `running|${running.started}|${formatAge(now - running.started)}`;
      if (key === this.#operationKey) return;
      this.#operationKey = key;
      replace(
        this.#operation,
        el(
          "div",
          { class: "op-card running", attrs: { "data-outcome": "running" } },
          icon("waiting"),
          el(
            "div",
            null,
            el("strong", null, running.operation.progress),
            el(
              "p",
              null,
              `Started at ${formatTime(running.started, now)}, ${formatAge(now - running.started)} ago. The page runs one operation at a time.`,
            ),
          ),
        ),
      );
      this.#operation.hidden = false;
      return;
    }
    if (last === null || last === this.#dismissed) {
      this.#operationKey = "";
      replace(this.#operation);
      this.#operation.hidden = true;
      return;
    }
    const key = `done|${last.started}|${last.ended}`;
    if (key === this.#operationKey) return;
    this.#operationKey = key;
    const text = describeOutcome(last.operation, last.outcome);
    replace(
      this.#operation,
      el(
        "div",
        {
          class: `op-card ${text.ok ? "ok" : "failed"}`,
          attrs: { "data-outcome": text.ok ? "ok" : "failed", "data-op": last.operation.op },
        },
        icon(text.ok ? "ok" : "failed"),
        el(
          "div",
          null,
          el("strong", null, text.headline),
          text.lines.length === 0
            ? null
            : el("ul", null, ...text.lines.map((line) => el("li", null, line))),
          el("p", { class: "muted" }, `Ended at ${formatTime(last.ended, now)}.`),
        ),
        button(
          "Dismiss",
          () => {
            this.#dismissed = last;
            this.render();
          },
          { class: "dismiss" },
        ),
      ),
    );
    this.#operation.hidden = false;
  }

  #run(operation: Operation): void {
    void this.#operations.run(operation).then(() => this.render());
    this.render();
  }

  #targetName(): string {
    return this.#model.target ?? "the rack that the dashboard watches";
  }

  #askReload(): void {
    const operation = reloadOperation(this.#targetName());
    this.#dialog.ask(operation.title, [{ label: operation.title, operation }], (chosen) =>
      this.#run(chosen),
    );
  }

  #askStop(): void {
    const operation = stopOperation(this.#targetName());
    this.#dialog.ask(operation.title, [{ label: operation.title, operation }], (chosen) =>
      this.#run(chosen),
    );
  }

  #askSwap(device: SlotStatus): void {
    const operation = swapOperation(device);
    this.#dialog.ask(operation.title, [{ label: operation.title, operation }], (chosen) =>
      this.#run(chosen),
    );
  }

  #askRestart(device: SlotStatus): void {
    const choices: Choice[] = [
      { label: "With its consumers", operation: restartOperation(device, true) },
      { label: "Alone, without its consumers", operation: restartOperation(device, false) },
    ];
    this.#dialog.ask(`Restart ${device.name}`, choices, (chosen) => this.#run(chosen));
  }

  #askRollback(device: SlotStatus): void {
    const now = this.#now();
    const choices: Choice[] = rollbackTargets(device, this.#model.history ?? []).map((target) => {
      if (target.source === "known-good") {
        return {
          label: `Its known-good firmware, ${shortHash(target.hash)}`,
          detail: "which it falls back to when an instance crashes on probation",
          operation: rollbackOperation(device, target),
        };
      }
      const record = target.record;
      const when = `the ${record.cause} #${record.seq} at ${formatTime(record.time, now)}`;
      return {
        label: `Firmware ${shortHash(target.hash)}`,
        detail:
          target.role === "from"
            ? `which ${when} replaced`
            : `which ${when} ${record.ok ? "installed" : "tried to install, and failed"}`,
        operation: rollbackOperation(device, target),
      };
    });
    this.#dialog.ask(`Roll back ${device.name}`, choices, (chosen) => this.#run(chosen));
  }
}

function panel(name: string, title: string, content: HTMLElement): HTMLElement {
  return el(
    "section",
    { class: `panel ${name}` },
    el("h2", { class: "panel-title" }, title),
    content,
  );
}

function tile(name: string, label: string, value: string): HTMLElement {
  return el(
    "div",
    { class: "tile", attrs: { "data-tile": name } },
    el("span", { class: "tile-label" }, label),
    el("span", { class: "tile-value" }, value),
  );
}
