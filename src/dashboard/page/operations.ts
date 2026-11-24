/**
 * The operations that the page runs: Reload and Stop for the rack, and Swap, Restart, and Roll
 * back for a device. Each names what it does, for the dialog that asks first; the page runs one at
 * a time, and shows its outcome. This module uses no API of the DOM or of Bun, so that tests run
 * it in Bun.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#operations-from-the-page
 */
import type { ReloadResult, SlotStatus, UpdateRecord } from "../../reports.ts";
import { OPERATION_WAIT_MS, type Outcome } from "./api.ts";
import { errorText, shortHash } from "./format.ts";

/** The operations that the page runs. */
export type OperationName = "reload" | "stop" | "swap" | "restart" | "rollback";

/** An operation, with its arguments and what the dialog that asks first says about it. */
export interface Operation {
  op: OperationName;
  /** The arguments, as the rack handle's method takes them. */
  args: unknown[];
  /** The device it acts on, or `null` for the rack. */
  device: string | null;
  /** What it is, such as `Restart web`. */
  title: string;
  /** What it does, one sentence each. */
  description: string[];
  /** The label of the button that confirms it. */
  confirm: string;
  /** What the page shows while it runs, such as `Restarting web…`. */
  progress: string;
  /** Whether it ends what the page can't start again: Stop. */
  danger: boolean;
}

/**
 * Reload: rebuild the firmware, and replace the devices whose hash changed.
 *
 * @param target What the dashboard watches, as `about` names it.
 */
export function reloadOperation(target: string): Operation {
  return {
    op: "reload",
    args: [],
    device: null,
    title: "Reload the rack",
    description: [
      `Rebuild the firmware of every device of the rack of ${target}.`,
      "Replace the devices whose firmware hash changed, and leave the others running as they are.",
    ],
    confirm: "Reload",
    progress: "Reloading the rack…",
    danger: false,
  };
}

/**
 * Stop: the rack shuts down, and the dashboard can't start it again.
 *
 * @param target What the dashboard watches, as `about` names it.
 */
export function stopOperation(target: string): Operation {
  return {
    op: "stop",
    args: [],
    device: null,
    title: "Stop the rack",
    description: [
      `Stop the rack of ${target}.`,
      "The rack shuts down: its devices power off, from the top down.",
      "The dashboard can't start it again. Start it again the way it was started, such as with rack start.",
    ],
    confirm: "Stop the rack",
    progress: "Stopping the rack…",
    danger: true,
  };
}

/**
 * Swap: a new build of the device's own file replaces its running instance.
 *
 * @param device The device, as `status()` reports it.
 */
export function swapOperation(device: SlotStatus): Operation {
  return {
    op: "swap",
    args: [device.name],
    device: device.name,
    title: `Swap ${device.name}`,
    description: [
      `Build ${device.name} anew from its file, ${device.source}, and replace its running instance with the new build.`,
      "If the new build fails, the running instance goes on serving.",
    ],
    confirm: "Swap",
    progress: `Swapping ${device.name}…`,
    danger: false,
  };
}

/**
 * Restart: the device stops completely and starts again from scratch, without its state, with or
 * without its consumers reloading after it.
 *
 * @param device The device, as `status()` reports it.
 * @param cascade Whether its direct consumers reload to adapt to it.
 */
export function restartOperation(device: SlotStatus, cascade: boolean): Operation {
  return {
    op: "restart",
    args: cascade ? [device.name] : [device.name, { cascade: false }],
    device: device.name,
    title: cascade ? `Restart ${device.name} with its consumers` : `Restart ${device.name} alone`,
    description: [
      `Stop ${device.name} completely, and start it again from scratch, rebuilt from its file, without its state.`,
      cascade
        ? "Then its direct consumers reload to adapt to it, keeping their state."
        : "Its consumers go on running as they are.",
    ],
    confirm: "Restart",
    progress: `Restarting ${device.name}…`,
    danger: false,
  };
}

/** A firmware that a device can roll back to. */
export type RollbackTarget =
  /** Its known-good firmware, which it falls back to when an instance crashes on probation. */
  | { hash: string; source: "known-good" }
  /** A firmware that an update in its history installed, `role: "to"`, or replaced, `"from"`. */
  | { hash: string; source: "history"; record: UpdateRecord; role: "from" | "to" };

/**
 * The firmwares a device can roll back to: its known-good firmware, then the ones its history
 * lists, the newest first, each once, and none that it runs.
 *
 * @param device The device, as `status()` reports it.
 * @param history The rack's history, newest first.
 * @returns The targets.
 */
export function rollbackTargets(
  device: SlotStatus,
  history: readonly UpdateRecord[],
): RollbackTarget[] {
  const targets: RollbackTarget[] = [];
  const seen = new Set<string>();
  if (device.firmware !== null) seen.add(device.firmware);
  if (device.knownGood !== null && !seen.has(device.knownGood)) {
    seen.add(device.knownGood);
    targets.push({ hash: device.knownGood, source: "known-good" });
  }
  for (const record of history) {
    if (record.device !== device.name) continue;
    for (const role of ["to", "from"] as const) {
      const hash = record[role];
      if (hash === null || seen.has(hash)) continue;
      seen.add(hash);
      targets.push({ hash, source: "history", record, role });
    }
  }
  return targets;
}

/**
 * Roll back: the device's firmware is replaced with an earlier one, its known-good one or one
 * that its history lists.
 *
 * @param device The device, as `status()` reports it.
 * @param target The firmware to roll back to.
 */
export function rollbackOperation(device: SlotStatus, target: RollbackTarget): Operation {
  const which =
    target.source === "known-good"
      ? `its known-good firmware, ${shortHash(target.hash)}`
      : `firmware ${shortHash(target.hash)}, which its history lists`;
  return {
    op: "rollback",
    args: [device.name, { to: target.hash }],
    device: device.name,
    title: `Roll back ${device.name}`,
    description: [
      `Replace the firmware that ${device.name} runs, ${shortHash(device.firmware)}, with ${which}.`,
      "The rack replaces it as a reload does, and its history records the rollback.",
    ],
    confirm: "Roll back",
    progress: `Rolling back ${device.name}…`,
    danger: false,
  };
}

/** An operation that ended, with its outcome. */
export interface Done {
  operation: Operation;
  outcome: Outcome;
  /** When the page sent it, a millisecond timestamp. */
  started: number;
  /** When its answer came, a millisecond timestamp. */
  ended: number;
}

/** Sends an operation to the dashboard; the page passes its client's `call`. */
export type Send = (op: string, args: unknown[], waitMs: number) => Promise<Outcome>;

/** Runs the page's operations one at a time, and keeps the outcome of the last one. */
export class Operations {
  /** The operation that runs, and when it started; `null` while none does. */
  running: { operation: Operation; started: number } | null = null;
  /** The last operation that ended; `null` before one did. */
  last: Done | null = null;
  readonly #send: Send;
  readonly #now: () => number;

  /**
   * @param send Sends an operation to the dashboard.
   * @param now The clock, in milliseconds.
   */
  constructor(send: Send, now: () => number) {
    this.#send = send;
    this.#now = now;
  }

  /**
   * Runs an operation, unless one runs already.
   *
   * @param operation The operation.
   * @returns How it ended, or `null` when another one still ran, so that this one didn't start.
   */
  async run(operation: Operation): Promise<Done | null> {
    if (this.running !== null) return null;
    const started = this.#now();
    this.running = { operation, started };
    try {
      const outcome = await this.#send(operation.op, operation.args, OPERATION_WAIT_MS);
      const done: Done = { operation, outcome, started, ended: this.#now() };
      this.last = done;
      return done;
    } finally {
      this.running = null;
    }
  }
}

/** The outcome of an operation, as the page shows it. */
export interface OutcomeText {
  /** Whether it succeeded, every device of it included. */
  ok: boolean;
  /** One line that says how it ended. */
  headline: string;
  /** What it did to each device, or why it failed. */
  lines: string[];
}

/**
 * Writes how an operation ended: the devices it replaced, or its error with its code.
 *
 * @param operation The operation.
 * @param outcome Its outcome.
 * @returns The text.
 */
export function describeOutcome(operation: Operation, outcome: Outcome): OutcomeText {
  if (outcome.kind === "error") {
    return {
      ok: false,
      headline: `${operation.title} failed`,
      lines: [errorText(outcome.error)],
    };
  }
  if (outcome.kind === "failed") {
    // Only a wait past the dashboard's bound, or the page's, leaves the operation's end unknown.
    // @decision .agents/decisions/261124_055114-rack-dashboard.md#what-can-go-wrong
    const unknown = outcome.status === 504 || outcome.timedOut === true;
    return unknown
      ? {
          ok: false,
          headline: `${operation.title} didn't end within 10 minutes`,
          lines: ["It may still run. The history will show its outcome.", outcome.reason],
        }
      : { ok: false, headline: `${operation.title} failed`, lines: [outcome.reason] };
  }
  const value = outcome.value;
  if (Array.isArray(value)) {
    const results = value as ReloadResult[];
    const failed = results.filter((result) => result.error !== undefined);
    const lines = results.map(resultLine);
    if (results.length === 0) {
      return { ok: true, headline: `${operation.title}: no firmware changed`, lines: [] };
    }
    const count = results.length === 1 ? "1 device" : `${results.length} devices`;
    return failed.length === 0
      ? { ok: true, headline: `${operation.title}: replaced ${count}`, lines }
      : {
          ok: false,
          headline: `${operation.title}: ${failed.length} of ${count} failed`,
          lines,
        };
  }
  if (operation.op === "stop") {
    return { ok: true, headline: "The rack is shutting down", lines: [] };
  }
  if (operation.op === "swap") {
    return { ok: true, headline: `${operation.title}: the new build runs`, lines: [] };
  }
  return { ok: true, headline: `${operation.title}: done`, lines: [] };
}

/** One device of an operation's results, such as `web: hot, 1a2b3c4d → 5e6f7a8b`. */
function resultLine(result: ReloadResult): string {
  const change =
    result.from === result.to
      ? shortHash(result.to)
      : `${shortHash(result.from)} → ${shortHash(result.to)}`;
  const line = `${result.device}: ${result.mode}, ${change}`;
  return result.error === undefined ? line : `${line}, failed with ${errorText(result.error)}`;
}
