// The gauge line: filled cells (full blocks) then a thin track. Text only, so a redraw
// costs a few dozen bytes over BLE; no image has to be re-sent while it animates.

export const GAUGE_CELLS = 26;
const FILLED = '█'; // full block, present in the glasses font
const EMPTY = '━'; // heavy horizontal line, present in the glasses font

/** Number of filled cells for a 0..1 fraction. Any usage shows at least one cell. */
export function filledCells(fraction: number, cells: number = GAUGE_CELLS): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  if (fraction >= 1) return cells;
  return Math.max(1, Math.min(cells - 1, Math.round(fraction * cells)));
}

export function gaugeString(fraction: number, cells: number = GAUGE_CELLS): string {
  const n = filledCells(fraction, cells);
  return FILLED.repeat(n) + EMPTY.repeat(cells - n);
}

/** A gauge that is entirely track, used for the "off" half of the TRIPPED pulse. */
export const emptyGauge = (cells: number = GAUGE_CELLS): string => EMPTY.repeat(cells);

/**
 * Moves the displayed fraction toward the target at `ratePerSecond`, so the line fills
 * smoothly instead of jumping. Pure; the caller decides how often to redraw.
 */
export function stepGauge(current: number, target: number, dtMs: number, ratePerSecond = 1.2): number {
  if (!Number.isFinite(target)) return current;
  const maxStep = (ratePerSecond * Math.max(0, dtMs)) / 1000;
  if (Math.abs(target - current) <= maxStep) return target;
  return current + Math.sign(target - current) * maxStep;
}
