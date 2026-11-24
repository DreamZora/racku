/**
 * The dialog that asks before an operation runs: it names the device, or the rack's target, and
 * what the operation does, and lets the operator choose among its forms, such as a restart with or
 * without the consumers.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#operations-from-the-page
 */
import { button, el, replace } from "./dom.ts";
import type { Operation } from "./operations.ts";

/** One form of an operation that the dialog offers. */
export interface Choice {
  /** What the operator chooses, such as `with its consumers`. */
  label: string;
  /** More about it, such as when the firmware was installed. */
  detail?: string;
  /** The operation it runs. */
  operation: Operation;
}

/** The dialog, of which the page has one. */
export class ConfirmDialog {
  /** The dialog's element. */
  readonly root: HTMLDialogElement;
  readonly #title: HTMLHeadingElement;
  readonly #choices: HTMLFieldSetElement;
  readonly #description: HTMLDivElement;
  readonly #confirm: HTMLButtonElement;
  readonly #cancel: HTMLButtonElement;
  #current: Choice[] = [];
  #chosen = 0;
  #onConfirm: ((operation: Operation) => void) | null = null;

  constructor() {
    this.#title = el("h2", { attrs: { id: "confirm-title" } });
    this.#choices = el("fieldset", { class: "choices" });
    this.#description = el("div", { class: "description", attrs: { id: "confirm-description" } });
    this.#cancel = button("Cancel", () => this.close(), { class: "cancel" });
    this.#confirm = button("Confirm", () => this.#run(), {
      class: "confirm",
      attrs: { "data-confirm": "" },
    });
    this.root = el(
      "dialog",
      {
        class: "confirm-dialog",
        attrs: { "aria-labelledby": "confirm-title", "aria-describedby": "confirm-description" },
      },
      this.#title,
      this.#choices,
      this.#description,
      el("div", { class: "buttons" }, this.#cancel, this.#confirm),
    );
    // Escape closes the dialog without running anything.
    this.root.addEventListener("close", () => {
      this.#onConfirm = null;
    });
  }

  /** Whether the dialog is open. */
  get open(): boolean {
    return this.root.open;
  }

  /**
   * Asks before an operation runs.
   *
   * @param heading What the dialog is about, such as `Restart web`.
   * @param choices The forms of the operation; the first is chosen at first.
   * @param onConfirm Runs the chosen operation once the operator confirms it.
   */
  ask(heading: string, choices: Choice[], onConfirm: (operation: Operation) => void): void {
    if (choices.length === 0) return;
    this.#current = choices;
    this.#chosen = 0;
    this.#onConfirm = onConfirm;
    this.#title.textContent = heading;
    this.#choices.hidden = choices.length < 2;
    replace(
      this.#choices,
      el("legend", null, "Choose"),
      ...choices.map((choice, index) => {
        const input = el("input", {
          attrs: {
            type: "radio",
            name: "choice",
            value: String(index),
            "data-choice": String(index),
          },
        });
        input.checked = index === 0;
        input.addEventListener("change", () => {
          if (input.checked) this.#choose(index);
        });
        return el(
          "label",
          { class: "choice" },
          input,
          el(
            "span",
            null,
            el("span", { class: "choice-label" }, choice.label),
            choice.detail === undefined
              ? null
              : el("span", { class: "choice-detail" }, choice.detail),
          ),
        );
      }),
    );
    this.#choose(0);
    if (!this.root.open) this.root.showModal();
    this.#cancel.focus();
  }

  /** Closes the dialog without running anything. */
  close(): void {
    this.#onConfirm = null;
    if (this.root.open) this.root.close();
  }

  #choose(index: number): void {
    const choice = this.#current[index];
    if (choice === undefined) return;
    this.#chosen = index;
    replace(
      this.#description,
      ...choice.operation.description.map((sentence) => el("p", null, sentence)),
    );
    this.#confirm.textContent = choice.operation.confirm;
    this.#confirm.classList.toggle("danger", choice.operation.danger);
    this.#confirm.dataset.op = choice.operation.op;
  }

  #run(): void {
    const choice = this.#current[this.#chosen];
    const run = this.#onConfirm;
    this.close();
    if (choice !== undefined && run !== null) run(choice.operation);
  }
}
