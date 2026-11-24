/**
 * The geometry of the page's charts and of the rack's front: scales, the runs of a line between
 * its gaps, the point nearest a time, and where each device of the front goes. This module uses no
 * API of the DOM or of Bun, so that tests run it in Bun.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 */
import type { SlotStatus } from "../../reports.ts";

/** How far back a device's chart reaches, in ms: 2 minutes. */
export const CHART_SPAN_MS = 120_000;

/** The fewest units the rack's front shows, as a 42U rack has. */
export const RACK_UNITS = 42;

/**
 * The smallest round number that is at least a value, for the top of a chart's scale: 1, 2, 2.5,
 * or 5 times a power of ten.
 *
 * @param value The largest value the chart shows.
 * @returns The top of the scale; 1 for a value that is 0 or less.
 */
export function niceCeiling(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const top = step * power;
    if (top >= value * (1 - 1e-9)) return top;
  }
  return 10 * power;
}

/** A point of a series: a time, and its value or `null` for a gap. */
export interface SeriesPoint {
  time: number;
  value: number | null;
}

/**
 * Splits a series into the runs that a line draws, between its gaps, keeping only the points
 * within a time range.
 *
 * @param points The points, oldest first.
 * @param from The start of the range, a millisecond timestamp.
 * @param to The end of the range.
 * @returns The runs, each one or more points with values.
 */
export function runsOf(
  points: readonly SeriesPoint[],
  from: number,
  to: number,
): Array<Array<{ time: number; value: number }>> {
  const runs: Array<Array<{ time: number; value: number }>> = [];
  let run: Array<{ time: number; value: number }> = [];
  for (const point of points) {
    if (point.time < from || point.time > to) continue;
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ time: point.time, value: point.value });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * The index of the point nearest a time.
 *
 * @param times The points' times, oldest first.
 * @param time The time the pointer is at.
 * @returns The index, or -1 for no points.
 */
export function nearestIndex(times: readonly number[], time: number): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < times.length; index++) {
    const d = Math.abs((times[index] as number) - time);
    if (d < distance) {
      best = index;
      distance = d;
    }
  }
  return best;
}

/**
 * How many units the rack's front shows: {@link RACK_UNITS}, or more when a device sits higher.
 * `status()` reports each device's slot and height, not the rack's size.
 *
 * @param devices The devices, as `status()` reports them.
 * @returns The number of units.
 */
export function unitsOf(devices: readonly SlotStatus[]): number {
  let top = RACK_UNITS;
  for (const device of devices) top = Math.max(top, device.u + device.height - 1);
  return top;
}

/** Where a device or an empty unit goes on the rack's front, counted in rows from the top. */
export interface FrontPlace {
  /** The first row it takes, from 1 at the top. */
  row: number;
  /** How many rows it takes. */
  rows: number;
}

/**
 * Where a device goes on the front: its top unit's row, counting the rows from the top, and as
 * many rows as the units it takes.
 *
 * @param device The device's lowest slot `u` and `height`.
 * @param units How many units the front shows.
 */
export function placeOf(device: Pick<SlotStatus, "u" | "height">, units: number): FrontPlace {
  const top = device.u + device.height - 1;
  return { row: units - top + 1, rows: device.height };
}

/**
 * The units that no device takes.
 *
 * @param devices The devices, as `status()` reports them.
 * @param units How many units the front shows.
 * @returns Their numbers, from the top down.
 */
export function emptyUnits(devices: readonly SlotStatus[], units: number): number[] {
  const taken = new Set<number>();
  for (const device of devices) {
    for (let unit = device.u; unit < device.u + device.height; unit++) taken.add(unit);
  }
  const empty: number[] = [];
  for (let unit = units; unit >= 1; unit--) if (!taken.has(unit)) empty.push(unit);
  return empty;
}
