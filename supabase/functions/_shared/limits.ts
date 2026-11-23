// Risk maths for the daily loss limit. Pure functions, no I/O, no runtime globals,
// so the same file runs under Deno (Edge Functions), Node (tests) and the browser.
//
// All comparisons are done in integer cents to avoid float drift at the thresholds.

export const MAX_DAILY_LIMIT = 1_000_000;
/** Fraction of the limit at which the state changes from CALM to CLOSING. */
export const CLOSING_THRESHOLD = 0.8;

export type RiskState = "CALM" | "CLOSING" | "TRIPPED";

export interface RiskInput {
  /** Daily loss limit in USD (positive number). */
  limit: number;
  /** Realised PnL since the start of the UTC day, USD (negative = loss). */
  realizedPnl: number;
  /** Unrealised PnL of open positions, USD (negative = loss). */
  unrealizedPnl: number;
}

export interface RiskStatus {
  limit: number;
  /** Net PnL for the day (realised + unrealised), USD. */
  pnl: number;
  /** Loss used so far, USD, never negative. A net profit gives 0. */
  used: number;
  /** Distance to the limit, USD, never negative. */
  left: number;
  /** used / limit, clamped to 0..1. */
  fraction: number;
  state: RiskState;
}

const toCents = (usd: number): number => Math.round(usd * 100);
const fromCents = (cents: number): number => cents / 100;

/** Validates a user-supplied daily limit. Throws RangeError on anything unusable. */
export function validateLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError("limit must be a finite number");
  }
  const cents = toCents(value);
  if (cents < 100) throw new RangeError("limit must be at least 1 USD");
  if (cents > MAX_DAILY_LIMIT * 100) {
    throw new RangeError(`limit must be at most ${MAX_DAILY_LIMIT} USD`);
  }
  return fromCents(cents);
}

/**
 * Computes the distance to the limit. Fails closed: non-finite PnL throws instead of
 * being shown as a calm state, because "CALM" on bad data is the dangerous failure.
 */
export function computeRisk(input: RiskInput): RiskStatus {
  const limit = validateLimit(input.limit);
  if (!Number.isFinite(input.realizedPnl) || !Number.isFinite(input.unrealizedPnl)) {
    throw new RangeError("pnl values must be finite numbers");
  }
  const limitCents = toCents(limit);
  const pnlCents = toCents(input.realizedPnl) + toCents(input.unrealizedPnl);
  const usedCents = Math.max(0, -pnlCents);
  const leftCents = Math.max(0, limitCents - usedCents);
  const fraction = Math.min(1, usedCents / limitCents);

  let state: RiskState;
  if (usedCents >= limitCents) state = "TRIPPED";
  else if (usedCents * 10 >= limitCents * 8) state = "CLOSING"; // >= 80%, integer maths
  else state = "CALM";

  return {
    limit,
    pnl: fromCents(pnlCents),
    used: fromCents(usedCents),
    left: fromCents(leftCents),
    fraction,
    state,
  };
}

/** Start of the UTC day containing `nowMs`, in epoch milliseconds. */
export function utcDayStart(nowMs: number): number {
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be finite");
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole-dollar display with thousands separators, e.g. 1234.9 -> "$1,234".
 * Rounds DOWN so the glasses never overstate the remaining headroom.
 */
export function formatUsdWhole(usd: number): string {
  if (!Number.isFinite(usd)) return "$--";
  const whole = Math.floor(Math.max(0, usd) + 1e-9);
  return "$" + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
